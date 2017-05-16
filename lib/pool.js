"use strict";
const debug = require('debug')('pool');
const uuidV4 = require('uuid/v4');
const crypto = require('crypto');
const bignum = require('bignum');
const cluster = require('cluster');
const btcValidator = require('wallet-address-validator');
const async = require('async');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const request = require('request');

let nonceCheck = new RegExp("^[0-9a-f]{8}$");
let bannedIPs = [];
let bannedAddresses = [];
let baseDiff = global.coinFuncs.baseDiff();
let pastBlockTemplates = global.support.circularBuffer(4);
let activeMiners = [];
let activeBlockTemplate;
let workerList = [];
let httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 18\n\nMining Pool Online';
let threadName;
let minerCount = [];
let BlockTemplate = global.coinFuncs.BlockTemplate;
let hexMatch = new RegExp("^[0-9a-f]+$");

Buffer.prototype.toByteArray = function () {
    return Array.prototype.slice.call(this, 0);
};


if (cluster.isMaster) {
    threadName = "(Master) ";
} else {
    threadName = "(Worker " + cluster.worker.id + " - " + process.pid + ") ";
}

let sendQueue = async.queue(function (task, callback) {
    async.doUntil(
        function (intCallback) {
            request.post({url: global.config.general.shareHost, body: task.body}, function (error, response, body) {
                if (!error) {
                    return intCallback(null, response.statusCode);
                }
                return intCallback(null, 0);
            });
        },
        function (data) {
            return data === 200;
        },
        function () {
            callback();
        });
}, 32);

let sendMsg = function(msg, exInt, msgType){
    if (global.config.hasOwnProperty('solo') && global.config.solo){
        return;
    }
    let wsData = global.protos.WSData.encode({
        msgType: msgType,
        key: global.config.api.authKey,
        msg: msg,
        exInt: exInt
    });
    sendQueue.push({body: wsData});
};

function registerPool() {
    let portList = [];
    async.forEachOf(global.config.ports, function (portData, portIndex, callback) {
        portList.append({
            port: portData.port,
            startingDiff: portData.difficulty,
            type: portData.portType,
            desc: portData.desc,
            hidden: portData.hidden,
            ssl: portData.ssl,
            miners: minerCount.hasOwnProperty(portData.port) ? minerCount[portData.port] : 0
        });
        return callback();
    }, function () {
        sendMsg(global.protos.PoolReg.encode({
            poolID: global.config.pool_id,
            poolIP: global.config.bind_ip,
            hostname: global.config.hostname,
            ports: portList,
            blockID: activeBlockTemplate.hasOwnProperty('height') ? activeBlockTemplate.height : 0
        }), 1, global.protos.MESSAGETYPE.POOLREG);
    });
}

// Master/Slave communication Handling
function messageHandler(message) {
    switch (message.type) {
        case 'banIP':
            debug(threadName + "Received ban IP update from nodes");
            if (cluster.isMaster) {
                sendToWorkers(message);
            } else {
                bannedIPs.push(message.data);
            }
            break;
        case 'newBlockTemplate':
            debug(threadName + "Received new block template");
            if (cluster.isMaster) {
                sendToWorkers(message);
                newBlockTemplate(message.data);
            } else {
                newBlockTemplate(message.data);
            }
            break;
        case 'removeMiner':
            if (cluster.isMaster) {
                minerCount[message.data] -= 1;
            }
            break;
        case 'newMiner':
            if (cluster.isMaster) {
                minerCount[message.data] += 1;
            }
            break;
    }
}

process.on('message', messageHandler);

function sendToWorkers(data) {
    let goodWorkers = [];
    workerList.forEach(function (worker) {
        try {
            if (worker.send(data)) {
                goodWorkers.push(worker);
            }
        } catch (e) {
            console.log(threadName + "Worker dead.  Not sending new messages.");
        }
    });
    workerList = goodWorkers;
}

function retargetMiners() {
    debug(threadName + "Performing difficulty check on miners");
    for (let minerId in activeMiners) {
        if (activeMiners.hasOwnProperty(minerId)) {
            let miner = activeMiners[minerId];
            if (!miner.fixed_diff) {
                miner.updateDifficulty();
            }
        }
    }
}

function checkAliveMiners() {
    debug(threadName + "Verifying if miners are still alive");
    for (let minerId in activeMiners) {
        if (activeMiners.hasOwnProperty(minerId)) {
            let miner = activeMiners[minerId];
            if (Date.now() - miner.lastContact > global.config.pool.minerTimeout * 1000) {
                process.send({type: 'removeMiner', data: miner.port});
                delete activeMiners[minerId];
            }
        }
    }
}

function templateUpdate(repeating) {
    global.coinFuncs.getBlockTemplate(global.config.pool.address, function (rpcResponse) {
        if (rpcResponse) {
            rpcResponse = rpcResponse.result;
            let buffer = new Buffer(rpcResponse.blocktemplate_blob, 'hex');
            let new_hash = new Buffer(32);
            buffer.copy(new_hash, 0, 7, 39);
            if (!activeBlockTemplate || new_hash.toString('hex') !== activeBlockTemplate.previous_hash.toString('hex')) {
                debug(threadName + "New block template found at " + rpcResponse.height + " height with hash: " + new_hash.toString('hex'));
                if (cluster.isMaster) {
                    sendToWorkers({type: 'newBlockTemplate', data: rpcResponse});
                    newBlockTemplate(rpcResponse);
                } else {
                    process.send({type: 'newBlockTemplate', data: rpcResponse});
                    newBlockTemplate(rpcResponse);
                }
            }
            if (repeating !== false) {
                setTimeout(templateUpdate, 300);
            }
        }
    });
}

function newBlockTemplate(template) {
    let buffer = new Buffer(template.blocktemplate_blob, 'hex');
    let previous_hash = new Buffer(32);
    buffer.copy(previous_hash, 0, 7, 39);
    console.log(threadName + 'New block to mine at height: ' + template.height + '.  Difficulty: ' + template.difficulty);
    if (activeBlockTemplate) {
        pastBlockTemplates.enq(activeBlockTemplate);
    }
    activeBlockTemplate = new BlockTemplate(template);
    for (let minerId in activeMiners) {
        if (activeMiners.hasOwnProperty(minerId)) {
            let miner = activeMiners[minerId];
            debug(threadName + "Updating worker " + miner.payout + " With new work at height: " + template.height);
            miner.messageSender('job', miner.getJob());
        }
    }
}

let VarDiff = (function () {
    let variance = global.config.pool.varDiffVariance / 100 * global.config.pool.targetTime;
    return {
        tMin: global.config.pool.targetTime - variance,
        tMax: global.config.pool.targetTime + variance
    };
})();

function Miner(id, login, pass, ipAddress, startingDiff, messageSender, protoVersion, portType, port, agent) {
    // Username Layout - <address in BTC or XMR>.<Difficulty>
    // Password Layout - <password>.<miner identifier>.<payment ID for XMR>
    // Default function is to use the password so they can login.  Identifiers can be unique, payment ID is last.
    // If there is no miner identifier, then the miner identifier is set to the password
    // If the password is x, aka, old-logins, we're not going to allow detailed review of miners.

    // Miner Variables
    let pass_split = pass.split(":");
    this.error = "";
    this.identifier = pass_split[0];
    if (agent && agent.includes('MinerGate')) {
        this.identifier = "MinerGate";
    }
    this.paymentID = null;
    this.valid_miner = true;
    this.port = port;
    this.portType = portType;
    this.incremented = false;
    switch (portType) {
        case 'pplns':
            this.poolTypeEnum = global.protos.POOLTYPE.PPLNS;
            break;
        case 'pps':
            this.poolTypeEnum = global.protos.POOLTYPE.PPS;
            break;
        case 'solo':
            this.poolTypeEnum = global.protos.POOLTYPE.SOLO;
            break;
        case 'prop':
            this.poolTypeEnum = global.protos.POOLTYPE.PROP;
            break;
    }
    let diffSplit = login.split("+");
    let addressSplit = diffSplit[0].split('.');
    this.address = addressSplit[0];
    this.payout = addressSplit[0];
    this.fixed_diff = false;
    this.difficulty = startingDiff;
    this.connectTime = Date.now();
    if (agent && agent.includes('NiceHash')) {
        this.fixed_diff = true;
        this.difficulty = global.coinFuncs.niceHashDiff;
    }
    if (diffSplit.length === 2) {
        this.fixed_diff = true;
        this.difficulty = Number(diffSplit[1]);
        if (this.difficulty < global.config.pool.minDifficulty) {
            this.difficulty = global.config.pool.minDifficulty;
        }
        if (this.difficulty > global.config.pool.maxDifficulty) {
            this.difficulty = global.config.pool.maxDifficulty;
        }
    } else if (diffSplit.length > 2) {
        this.error = "Too many options in the login field";
        this.valid_miner = false;
    }
    if (typeof(addressSplit[1]) !== 'undefined' && addressSplit[1].length === 64 && hexMatch.test(addressSplit[1])) {
        this.paymentID = addressSplit[1];
        this.payout = this.address + "." + this.paymentID;
    } else if (typeof(addressSplit[1]) !== 'undefined') {
        this.identifier = pass_split[0] === 'x' ? addressSplit[1] : pass_split[0];
    }
    if (typeof(addressSplit[2]) !== 'undefined') {
        this.identifier = pass_split[0] === 'x' ? addressSplit[2] : pass_split[0];
    }

    if (pass_split.length === 2) {
        /*
         Email address is: pass_split[1]
         Need to do an initial registration call here.  Might as well do it right...
         */
        sendMsg(global.protos.RegisterUser.encode({
            username: this.payout,
            password: pass_split[1]
        }), 1, global.protos.MESSAGETYPE.REGISTERUSER);
    } else if (pass_split.length > 2) {
        this.error = "Too many options in the password field";
        this.valid_miner = false;
    }

    if (global.coinFuncs.validateAddress(this.address)) {
        this.bitcoin = 0;
    } else if (btcValidator.validate(this.address) && global.config.general.allowBitcoin) {
        this.bitcoin = 1;
    } else if (btcValidator.validate(this.address)) {
        this.error = "This pool does not allow payouts to bitcoin.";
        this.valid_miner = false;
    } else {
        // Invalid Addresses
        this.error = "Invalid payment address provided";
        this.valid_miner = false;
    }
    if (bannedAddresses.indexOf(this.address) !== -1) {
        // Banned Address
        this.error = "Banned payment address provided";
        this.valid_miner = false;
    }
    if (global.coinFuncs.exchangeAddresses.indexOf(this.address) !== -1 && !(this.paymentID)) {
        this.error = "Exchange addresses need payment IDs";
        this.valid_miner = false;
    }

    this.id = id;
    this.ipAddress = ipAddress;
    this.messageSender = messageSender;
    this.heartbeat = function () {
        this.lastContact = Date.now();
    };
    this.heartbeat();

    // VarDiff System
    this.shareTimeBuffer = global.support.circularBuffer(8);
    this.shareTimeBuffer.enq(global.config.pool.targetTime);
    this.lastShareTime = Date.now() / 1000 || 0;

    this.validShares = 0;
    this.invalidShares = 0;
    this.hashes = 0;
    this.logString = this.address + " ID: " + this.identifier + " IP: " + this.ipAddress;

    if (global.config.pool.trustedMiners) {
        this.trust = {
            threshold: global.config.pool.trustThreshold,
            probability: 256,
            penalty: 0
        };
    }

    this.validJobs = global.support.circularBuffer(10);

    this.cachedJob = null;

    this.invalidShareProto = global.protos.InvalidShare.encode({
        paymentAddress: this.address,
        paymentID: this.paymentID,
        identifier: this.identifier
    });

    // Support functions for how miners activate and run.
    this.updateDifficultyOld = function () {
        let now = Math.round(Date.now() / 1000);
        let avg = this.shareTimeBuffer.average(this.lastShareTime);

        let sinceLast = now - this.lastShareTime;
        let decreaser = sinceLast > VarDiff.tMax;

        let newDiff;
        let direction;

        if (avg > VarDiff.tMax && this.difficulty > global.config.pool.minDifficulty) {
            newDiff = global.config.pool.targetTime / avg * this.difficulty;
            direction = -1;
        }
        else if (avg < VarDiff.tMin && this.difficulty < global.config.pool.maxDifficulty) {
            newDiff = global.config.pool.targetTime / avg * this.difficulty;
            direction = 1;
        }
        else {
            return;
        }

        if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > global.config.pool.maxDiffChange) {
            let change = global.config.pool.maxDiffChange / 100 * this.difficulty * direction;
            newDiff = this.difficulty + change;
        }

        this.setNewDiff(newDiff);
        this.shareTimeBuffer.clear();
        if (decreaser) {
            this.lastShareTime = now;
        }
    };

    this.updateDifficulty = function () {
        if (this.hashes > 0) {
            this.setNewDiff(Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) * global.config.pool.targetTime);
        } else {
            this.updateDifficultyOld();
        }
    };

    this.setNewDiff = function (difficulty) {
        this.newDiff = Math.round(difficulty);
        debug(threadName + "Difficulty: " + this.newDiff + " For: " + this.logString + " Time Average: " + this.shareTimeBuffer.average(this.lastShareTime) + " Entries: " + this.shareTimeBuffer.size() + "  Sum: " + this.shareTimeBuffer.sum());
        if (this.newDiff > global.config.pool.maxDifficulty) {
            this.newDiff = global.config.pool.maxDifficulty;
        }
        if (this.difficulty === this.newDiff) {
            return;
        }
        if (this.newDiff < global.config.pool.minDifficulty) {
            this.newDiff = global.config.pool.minDifficulty;
        }
        console.log(threadName + "Difficulty change to: " + this.newDiff + " For: " + this.logString);
        if (this.hashes > 0) {
            debug(threadName + "Hashes: " + this.hashes + " in: " + Math.floor((Date.now() - this.connectTime) / 1000) + " seconds gives: " +
                Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) + " hashes/second or: " +
                Math.floor(this.hashes / (Math.floor((Date.now() - this.connectTime) / 1000))) * global.config.pool.targetTime + " difficulty versus: " + this.newDiff);
        }
        this.messageSender('job', this.getJob());
    };

    this.checkBan = function (validShare) {
        if (!global.config.pool.banEnabled) {
            return;
        }

        // Valid stats are stored by the pool.
        if (validShare) {
            this.validShares += 1;
        } else {
            this.invalidShares += 1;
        }
        if (this.validShares + this.invalidShares >= global.config.pool.banThreshold) {
            if (this.invalidShares / this.validShares >= global.config.pool.banPercent / 100) {
                delete activeMiners[this.id];
                process.send({type: 'banIP', data: this.ipAddress});
            }
            else {
                this.invalidShares = 0;
                this.validShares = 0;
            }
        }
    };

    if (protoVersion === 1) {
        this.getTargetHex = function () {
            if (this.newDiff) {
                this.difficulty = this.newDiff;
                this.newDiff = null;
            }
            let padded = new Buffer(32);
            padded.fill(0);
            let diffBuff = baseDiff.div(this.difficulty).toBuffer();
            diffBuff.copy(padded, 32 - diffBuff.length);

            let buff = padded.slice(0, 4);
            let buffArray = buff.toByteArray().reverse();
            let buffReversed = new Buffer(buffArray);
            this.target = buffReversed.readUInt32BE(0);
            return buffReversed.toString('hex');
        };
        this.getJob = function () {

            if (this.lastBlockHeight === activeBlockTemplate.height && !this.newDiff && this.cachedJob !== null) {
                return this.cachedJob;
            }

            let blob = activeBlockTemplate.nextBlob();
            let target = this.getTargetHex();
            this.lastBlockHeight = activeBlockTemplate.height;


            let newJob = {
                id: crypto.pseudoRandomBytes(21).toString('base64'),
                extraNonce: activeBlockTemplate.extraNonce,
                height: activeBlockTemplate.height,
                difficulty: this.difficulty,
                diffHex: this.diffHex,
                submissions: []
            };

            this.validJobs.enq(newJob);
            this.cachedJob = {
                blob: blob,
                job_id: newJob.id,
                target: target,
                id: this.id
            };
            return this.cachedJob;
        };
    }
}

function recordShareData(miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate) {
    miner.hashes += job.difficulty;
    sendMsg(global.protos.Share.encode({
        shares: job.difficulty,
        paymentAddress: miner.address,
        paymentID: miner.paymentID,
        foundBlock: blockCandidate,
        trustedShare: shareType,
        poolType: miner.poolTypeEnum,
        poolID: global.config.pool_id,
        blockDiff: activeBlockTemplate.difficulty,
        bitcoin: miner.bitcoin,
        blockHeight: job.height,
        timestamp: Date.now(),
        identifier: miner.identifier
    }), job.height, global.protos.MESSAGETYPE.SHARE);
    if (blockCandidate) {
        sendMsg(global.protos.Block.encode({
            hash: hashHex,
            difficulty: blockTemplate.difficulty,
            shares: 0,
            timestamp: Date.now(),
            poolType: miner.poolTypeEnum,
            unlocked: false,
            valid: true
        }), job.height, global.protos.MESSAGETYPE.BLOCK);
    }
    if (shareType) {
        console.log(threadName + "Accepted trusted share at difficulty: " + job.difficulty + "/" + shareDiff + " from: " + miner.logString);
    } else {
        console.log(threadName + "Accepted valid share at difficulty: " + job.difficulty + "/" + shareDiff + " from: " + miner.logString);
    }

}

function processShare(miner, job, blockTemplate, nonce, resultHash) {
    let template = new Buffer(blockTemplate.buffer.length);
    blockTemplate.buffer.copy(template);
    template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
    let shareBuffer = global.coinFuncs.constructNewBlob(template, new Buffer(nonce, 'hex'));

    let convertedBlob;
    let hash;
    let shareType;

    if (global.config.pool.trustedMiners && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 &&
        crypto.randomBytes(1).readUIntBE(0, 1) > miner.trust.probability) {
        hash = new Buffer(resultHash, 'hex');
        shareType = true;
    }
    else {
        convertedBlob = global.coinFuncs.convertBlob(shareBuffer);
        hash = global.coinFuncs.cryptoNight(convertedBlob);
        shareType = false;
    }
    if (hash.toString('hex') !== resultHash) {
        console.error(threadName + "Bad hash from miner " + miner.logString);
        if (miner.incremented === false) {
            miner.newDiff = miner.difficulty + 1;
            miner.incremented = true;
        } else {
            miner.newDiff = miner.difficulty - 1;
            miner.incremented = false;
        }
        miner.messageSender('job', miner.getJob());
        return false;
    }

    let hashArray = hash.toByteArray().reverse();
    let hashNum = bignum.fromBuffer(new Buffer(hashArray));
    let hashDiff = baseDiff.div(hashNum);


    if (hashDiff.ge(blockTemplate.difficulty)) {
        // Submit block to the RPC Daemon.
        global.support.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function (rpcResult) {
            if (rpcResult.error) {
                // Did not manage to submit a block.  Log and continue on.
                console.error(threadName + "Error submitting block at height " + job.height + " from " + miner.logString + ", share type: " + shareType + " error: " + JSON.stringify(rpcResult.error));
                recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
                // Error on submit, so we'll submit a sanity check for good measure.
                templateUpdate(false);
            } else if (rpcResult) {
                //Success!  Submitted a block without an issue.
                let blockFastHash = global.coinFuncs.getBlockID(shareBuffer).toString('hex');
                console.log(threadName + "Block " + blockFastHash.substr(0, 6) + " found at height " + job.height + " by " + miner.logString +
                    ", share type: " + shareType + " - submit result: " + JSON.stringify(rpcResult.result));
                recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate);
                templateUpdate(false);
            } else {
                // RPC bombed out massively.
                console.error(threadName + "RPC Error.  Please check logs for details");
            }
        });
    }
    else if (hashDiff.lt(job.difficulty)) {
        console.warn(threadName + "Rejected low diff share of " + hashDiff.toString() + " from: " + miner.address + " ID: " +
            miner.identifier + " IP: " + miner.ipAddress);
        return false;
    }
    else {
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
    }
    return true;
}

function handleMinerData(method, params, ip, portData, sendReply, pushMessage) {
    let miner = activeMiners[params.id];
    // Check for ban here, so preconnected attackers can't continue to screw you
    if (bannedIPs.indexOf(ip) !== -1) {
        // Handle IP ban off clip.
        sendReply("IP Address currently banned");
        return;
    }
    switch (method) {
        case 'login':
            if (!params.login || (!params.pass && params.agent && !params.agent.includes('MinerGate'))) {
                sendReply("No login/password specified");
                return;
            }
            miner = new Miner(uuidV4(), params.login, params.pass, ip, portData.difficulty, pushMessage, 1, portData.portType, portData.port, params.agent);
            if (!miner.valid_miner) {
                console.log("Invalid miner, disconnecting due to: " + miner.error);
                sendReply(miner.error);
                return;
            }
            process.send({type: 'newMiner', data: miner.port});
            activeMiners[miner.id] = miner;
            sendReply(null, {
                id: miner.id,
                job: miner.getJob(),
                status: 'OK'
            });
            break;
        case 'mining.subscribe':
            if (!params.login || (!params.pass && params.agent && !params.agent.includes('MinerGate'))) {
                sendReply("No login/password specified");
                return;
            }
            miner = new Miner(uuidV4(), params.login, params.pass, ip, portData.difficulty, pushMessage, 2, portData.portType, portData.port, params.agent);
            if (!miner.valid_miner) {
                console.log("Invalid miner, disconnecting due to: " + miner.error);
                sendReply(miner.error);
                return;
            }
            process.send({type: 'newMiner', data: miner.port});
            activeMiners[miner.id] = miner;
            sendReply(null, {
                id: miner.id,
                job: miner.getJob(),
                status: 'OK'
            });
            break;
        case 'getjob':
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, miner.getJob());
            break;
        case 'submit':
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();

            let job = miner.validJobs.toarray().filter(function (job) {
                return job.id === params.job_id;
            })[0];

            if (!job) {
                sendReply('Invalid job id');
                return;
            }

            params.nonce = params.nonce.substr(0, 8).toLowerCase();
            if (!nonceCheck.test(params.nonce)) {
                console.warn(threadName + 'Malformed nonce: ' + JSON.stringify(params) + ' from ' + miner.logString);
                miner.checkBan(false);
                sendReply('Duplicate share');
                sendMsg(miner.invalidShareProto, 1, global.protos.MESSAGETYPE.INVALIDSHARE);
                return;
            }

            if (job.submissions.indexOf(params.nonce) !== -1) {
                console.warn(threadName + 'Duplicate share: ' + JSON.stringify(params) + ' from ' + miner.logString);
                miner.checkBan(false);
                sendReply('Duplicate share');
                sendMsg(miner.invalidShareProto, 1, global.protos.MESSAGETYPE.INVALIDSHARE);
                return;
            }

            job.submissions.push(params.nonce);

            let blockTemplate = activeBlockTemplate.height === job.height ? activeBlockTemplate : pastBlockTemplates.toarray().filter(function (t) {
                    return t.height === job.height;
                })[0];

            if (!blockTemplate) {
                console.warn(threadName + 'Block expired, Height: ' + job.height + ' from ' + miner.logString);
                if (miner.incremented === false) {
                    miner.newDiff = miner.difficulty + 1;
                    miner.incremented = true;
                } else {
                    miner.newDiff = miner.difficulty - 1;
                    miner.incremented = false;
                }
                miner.messageSender('job', miner.getJob());
                sendReply('Block expired');
                sendMsg(miner.invalidShareProto, 1, global.protos.MESSAGETYPE.INVALIDSHARE);
                return;
            }

            let shareAccepted = processShare(miner, job, blockTemplate, params.nonce, params.result);
            miner.checkBan(shareAccepted);

            if (global.config.pool.trustedMiners) {
                if (shareAccepted) {
                    miner.trust.probability -= 1;
                    if (miner.trust.probability < (global.config.pool.trustMin)) {
                        miner.trust.probability = global.config.pool.trustMin;
                    }
                    miner.trust.penalty--;
                    miner.trust.threshold--;
                }
                else {
                    console.log(threadName + "Share trust broken by " + miner.logString);
                    sendMsg(miner.invalidShareProto, 1, global.protos.MESSAGETYPE.INVALIDSHARE);
                    miner.trust.probability = 256;
                    miner.trust.penalty = global.config.pool.trustPenalty;
                    miner.trust.threshold = global.config.pool.trustThreshold;
                }
            }

            if (!shareAccepted) {
                sendReply('Low difficulty share');
                return;
            }

            let now = Date.now() / 1000 || 0;
            miner.shareTimeBuffer.enq(now - miner.lastShareTime);
            miner.lastShareTime = now;

            sendReply(null, {status: 'OK'});
            break;
        case 'keepalived':
            if (!miner) {
                sendReply('Unauthenticated');
                return;
            }
            sendReply(null, {
                status: 'KEEPALIVED'
            });
            break;
    }
}

if (cluster.isMaster) {
    let numWorkers = require('os').cpus().length;
    global.config.ports.forEach(function (portData) {
        minerCount[portData.port] = 0;
    });
    templateUpdate();
    registerPool();
    setInterval(registerPool, 10000);
    console.log('Master cluster setting up ' + numWorkers + ' workers...');

    for (let i = 0; i < numWorkers; i++) {
        let worker = cluster.fork();
        worker.on('message', messageHandler);
        workerList.push(worker);
    }

    cluster.on('online', function (worker) {
        console.log('Worker ' + worker.process.pid + ' is online');
    });

    cluster.on('exit', function (worker, code, signal) {
        console.log('Worker ' + worker.process.pid + ' died with code: ' + code + ', and signal: ' + signal);
        console.log('Starting a new worker');
        worker = cluster.fork();
        worker.on('message', messageHandler);
        workerList.push(worker);
    });
    global.support.sendEmail(global.config.general.adminEmail, "Pool server " + global.config.hostname + " online", "The pool server: " + global.config.hostname + " with IP: " + global.config.bind_ip + " is online");
} else {
    setInterval(checkAliveMiners, 30000);
    setInterval(retargetMiners, global.config.pool.retargetTime * 1000);
    templateUpdate(false);
    setInterval(function () {
        bannedIPs = [];
    }, 60000);
    async.each(global.config.ports, function (portData) {
        if (global.config[portData.portType].enable !== true) {
            return;
        }
        let handleMessage = function (socket, jsonData, pushMessage) {
            if (!jsonData.id) {
                console.warn('Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                console.warn('Miner RPC request missing RPC method');
                return;
            }
            else if (!jsonData.params) {
                console.warn('Miner RPC request missing RPC params');
                return;
            }

            let sendReply = function (error, result) {
                if (!socket.writable) {
                    return;
                }
                let sendData = JSON.stringify({
                        id: jsonData.id,
                        jsonrpc: "2.0",
                        error: error ? {code: -1, message: error} : null,
                        result: result
                    }) + "\n";
                socket.write(sendData);
            };
            handleMinerData(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage);
        };

        function socketConn(socket) {
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            let dataBuffer = '';

            let pushMessage = function (method, params) {
                if (!socket.writable) {
                    return;
                }
                let sendData = JSON.stringify({
                        jsonrpc: "2.0",
                        method: method,
                        params: params
                    }) + "\n";
                socket.write(sendData);
            };

            socket.on('data', function (d) {
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) { //10KB
                    dataBuffer = null;
                    console.warn(threadName + 'Excessive packet size from: ' + socket.remoteAddress);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1) {
                    let messages = dataBuffer.split('\n');
                    let incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    for (let i = 0; i < messages.length; i++) {
                        let message = messages[i];
                        if (message.trim() === '') {
                            continue;
                        }
                        let jsonData;
                        try {
                            jsonData = JSON.parse(message);
                        }
                        catch (e) {
                            if (message.indexOf('GET /') === 0) {
                                if (message.indexOf('HTTP/1.1') !== -1) {
                                    socket.end('HTTP/1.1' + httpResponse);
                                    break;
                                }
                                else if (message.indexOf('HTTP/1.0') !== -1) {
                                    socket.end('HTTP/1.0' + httpResponse);
                                    break;
                                }
                            }

                            console.warn(threadName + "Malformed message from " + socket.remoteAddress + " Message: " + message);
                            socket.destroy();

                            break;
                        }
                        handleMessage(socket, jsonData, pushMessage);
                    }
                    dataBuffer = incomplete;
                }
            }).on('error', function (err) {
                if (err.code !== 'ECONNRESET') {
                    console.warn(threadName + "Socket Error from " + socket.remoteAddress + " Error: " + err);
                }
            }).on('close', function () {
                pushMessage = function () {
                };
            });
        }

        if ('ssl' in portData && portData['ssl'] === true) {
            tls.createServer({
                key: fs.readFileSync('cert.key'),
                cert: fs.readFileSync('cert.pem')
            }, socketConn).listen(portData.port, global.config.bind_ip, function (error) {
                if (error) {
                    console.error(threadName + "Unable to start server on: " + portData.port + " Message: " + error);
                    return;
                }
                console.log(threadName + "Started server on port: " + portData.port);
            });
        } else {
            net.createServer(socketConn).listen(portData.port, global.config.bind_ip, function (error) {
                if (error) {
                    console.error(threadName + "Unable to start server on: " + portData.port + " Message: " + error);
                    return;
                }
                console.log(threadName + "Started server on port: " + portData.port);
            });
        }
    });
}
