'use strict';

var BaseService = require('../../service');
var inherits = require('util').inherits;
var async = require('async');
var index = require('../../');
var log = index.log;
var flocore = require('flocore-lib');
var Unit = flocore.Unit;
var _ = flocore.deps._;
var lodash = require('lodash');
var Encoding = require('./encoding');
var Transform = require('stream').Transform;
var assert = require('assert');
var utils = require('../../utils');
var LRU = require('lru-cache');
var XXHash = require('xxhash');

const MAX_TX_QUERY_LIMIT_HISTORY = 1000;
const MAX_TX_QUERY_LIMIT_UTXO = 1000;
const MAX_TX_QUERY_LIMIT_SUMMARY = 500;

// See rationale about this cache at function getTxList(next)
const TXID_LIST_CACHE_ITEMS = 250;              // nr of items (this translates to: consecutive 
                                                // clients downloading their tx history)
const TXID_LIST_CACHE_EXPIRATION = 1000 * 30;   // ms
const TXID_LIST_CACHE_MIN = 100;                // Min items to cache
const TXID_LIST_CACHE_SEED = 0x3233DE;                // Min items to cache

var AddressService = function(options) {

  BaseService.call(this, options);
  this._header = this.node.services.header;
  this._block = this.node.services.block;
  this._timestamp = this.node.services.timestamp;
  this._transaction = this.node.services.transaction;
  this._network = this.node.network;
  this._db = this.node.services.db;
  this._mempool = this.node.services.mempool;
  this._txIdListCache = new LRU({
    max: TXID_LIST_CACHE_ITEMS,        
    maxAge: TXID_LIST_CACHE_EXPIRATION 
  });
 

  if (this._network === 'livenet') {
    this._network = 'main';
  }
  if (this._network === 'regtest') {
    this._network = 'testnet';
  }

};

inherits(AddressService, BaseService);

AddressService.dependencies = [
  'db',
  'block',
  'header',
  'transaction',
  'timestamp',
  'mempool'
];

// this must return the to-from number of txs for ALL passed in addresses sort from latest txs to earliest
// for example if the query /api/addrs/txs?from=0&to=5&noAsm=1&noScriptSig=1&noSpent=1, and the addresses passed
// in are [addr1, addr2, addr3], then if addr3 has tx1 at height 10, addr2 has tx2 at height 9 and tx1 has no txs,
// then I would pass back [tx1, tx2] in that order
//
// Instead of passing addresses, with from>0, options.cacheKey can be used to define the address set.
//(old one: non-optimized for large data)
AddressService.prototype.__getAddressHistory = function(addresses, options, callback) {
  var self = this;
  var cacheUsed = false;

  options = options || {};
  options.from = options.from || 0;
  options.to = options.to || 0xffffffff;
  options.txIdList = [];

  if (_.isUndefined(options.queryMempool)) {
    options.queryMempool = true;
  }

  if (_.isString(addresses)) {
    addresses = [addresses];
  }


  function getTxList(next) {


    function hashAddresses(addresses) {

      // Given there are only TXID_LIST_CACHE_ITEMS ~ 250 items cached at the sametime
      // a 32 bits hash is secure enough

      return XXHash.hash(Buffer.from(addresses.join('')), TXID_LIST_CACHE_SEED);
    };

    var calculatedCacheKey;

    // We use the cache ONLY on from > 0 queries.
    //
    // Rationale: The a full history is downloaded, the client do
    // from =0, to=x
    // then from =x+1 to=y
    // then [...]
    // The objective of this cache is to speed up the from>0 queries, and also
    // "freeze" the txid list during download.
    //
    if (options.from >0 ) {
      
      let cacheKey  = options.cacheKey;
      if (!cacheKey) {
         calculatedCacheKey = hashAddresses(addresses);
         cacheKey =  calculatedCacheKey;
      }

      var txIdList  = self._txIdListCache.get(cacheKey);
      if (txIdList) {
        options.txIdList = txIdList;
        cacheUsed = true;
        return next();
      }
    }

    // Get the list from the db
    async.eachLimit(addresses, 4, function(address, next) {
      self._getAddressTxidHistory(address, options, next);
    }, function(err) {
      if (err) return next(err);

      var list = lodash.uniqBy(options.txIdList, function(x) { 
        return x.txid + x.height;
      });


      options.txIdList = lodash.orderBy(list,['height','txid'], ['desc','asc']);

      if (list.length > TXID_LIST_CACHE_MIN) {
        calculatedCacheKey  = calculatedCacheKey || hashAddresses(addresses);

        self._txIdListCache.set(calculatedCacheKey, options.txIdList);
      }

      return next();
    });

  };


  getTxList(function(err) {
    if(err) {
      return callback(err);
    }

    self._getAddressTxHistory(options, function(err, txList) {

      if (err) {
        return callback(err);
      }

      var results = {
        totalCount: options.txIdList.length || 0,
        items: txList,
      };

      // cacheUsed is returned for testing
      callback(null, results, cacheUsed);

    });
  });

};

AddressService.prototype.getAddressHistory = function(addresses, options, streamer, callback) {
  var self = this;

  options = options || {};
  //options.from = options.from || 0; //Deprecated, use `after` and `before` option
  //options.to = options.to || 0xffffffff; //Deprecated, use `after` and `before` option

  if(!_.isFunction(callback)){ //if only 3 args, then streamer is callback
    callback = streamer;
    streamer = () => null; //NULL fn
  }

  if (_.isUndefined(options.queryMempool)) {
    options.queryMempool = true;
  }

  if (_.isUndefined(options.mempoolOnly)) {
    options.mempoolOnly = false;
  }

  if(_.isUndefined(options.reverse)) {
    options.reverse = false;
  }

  var old_support = false;
  //Quick support for `from` and `to` options (DEPRECATED! Not recommeded to use)
  if(!_.isUndefined(options.from) || !_.isUndefined(options.to)) { 
    old_support = true;
    options.from = options.from || 0;
    options.to = options.to || 0xffffffff; //Max value of to will actually be MAX_TX_QUERY_LIMIT_HISTORY
  }

  if (_.isString(addresses)) {
    addresses = [addresses];
  }

  var results = {
    totalCount: 0,
    items: [],
  }

  async.eachLimit(addresses, 4, function(address, next) {

    var addr_options = Object.assign({}, options), addr_count = 0;

    self._streamAddressSummary(address, addr_options, function(err, tx){

      if(err)
        return log.error(err);

        addr_count++;

        if(!results.items.some(x => x.txid() === tx.txid())) {//add only if tx not already in array
          if(!options.reverse)
            results.items.unshift(tx); //using unshift, so that recent tx (low) are at front
          else
            results.items.push(tx);
        } 
          
        
        if(results.items.length > MAX_TX_QUERY_LIMIT_HISTORY) { //remove items from array when overflown
          results.items.sort((a, b) => (b.__height || 0xffffffff) - (a.__height || 0xffffffff) || b.txid().localeCompare(a.txid()));
          let del_count = results.items.length - MAX_TX_QUERY_LIMIT_HISTORY;
          let start_index = (old_support || options.reverse) ? MAX_TX_QUERY_LIMIT_HISTORY : 0;
          results.items.splice(start_index, del_count);

          results.incomplete = true;

          if(!old_support && addr_count >= MAX_TX_QUERY_LIMIT_HISTORY)
            addr_options.flag_stop = true; //limit has reached, stop quering db for more tx
                
        }
      
      streamer(null, tx);

    }, next);

  }, function(err) {

    if (err) {
      return callback(err);
    }

    //sort items in desc block-height, then asc txid (if same height)
    results.items.sort((a, b) => (b.__height || 0xffffffff) - (a.__height || 0xffffffff) || b.txid().localeCompare(a.txid()));
    results.totalCount = results.items.length ;

    //Quick support for `from` and `to` options (DEPRECATED! Not recommeded to use)
    if(old_support) { 
      results.items = results.items.slice(options.from, options.to);
    }

    callback(null, results);

  })

}
// this is basically the same as _getAddressHistory apart from the summary
//(old one: non-optimized for large data)
AddressService.prototype.__getAddressSummary = function(address, options, callback) {

  var self = this;

  options = options || {};
  options.from = options.from || 0;
  options.to = options.to || 0xffffffff;

  if (_.isUndefined(options.queryMempool)) {
    options.queryMempool = true;
  }

  var result = {
    addrStr: address,
    balance: 0,
    balanceSat: 0,
    totalReceived: 0,
    totalReceivedSat: 0,
    totalSent: 0,
    totalSentSat: 0,
    unconfirmedBalance: 0,
    unconfirmedBalanceSat: 0,
    unconfirmedTxApperances: 0,
    txApperances: 0,
  };

  self.__getAddressHistory(address, options, function(err, results) { //old fn

    if (err) {
      return callback(err);
    }

    var txs = results.items;
    self._getAddressSummaryResult(txs, address, result, options);

    result.balance = Unit.fromSatoshis(result.balanceSat).toBTC();
    result.totalReceived = Unit.fromSatoshis(result.totalReceivedSat).toBTC();
    result.totalSent = Unit.fromSatoshis(result.totalSentSat).toBTC();
    result.unconfirmedBalance = Unit.fromSatoshis(result.unconfirmedBalanceSat).toBTC();
    callback(null, result);
  });

};

AddressService.prototype.getAddressSummary = function(address, options, streamer, callback) {

  var self = this;

  options = options || {};
  //options.from = options.from || 0; //Deprecated, use `after` and `before` option
  //options.to = options.to || 0xffffffff; //Deprecated, use `after` and `before` option

  if (_.isUndefined(options.queryMempool)) {
    options.queryMempool = true;
  }

  if(!_.isFunction(callback)){ //if only 3 args, then streamer is callback
    callback = streamer;
    streamer = () => null; //NULL fn
  }

  var count = 0;

  var result = {
    addrStr: address,
    balance: 0,
    balanceSat: 0,
    totalReceived: 0,
    totalReceivedSat: 0,
    totalSent: 0,
    totalSentSat: 0,
    unconfirmedBalance: 0,
    unconfirmedBalanceSat: 0,
    unconfirmedTxApperances: 0,
    txApperances: 0,
  };

  var useCache = _.isUndefined(options.after) && _.isUndefined(options.before);
  var lastTx, lastBlock;

  self._loadCache(address, result, useCache, function(err, lastCachedTx) {
    if(err)
      log.error(err);
    
    if(!_.isUndefined(lastCachedTx))
      options.after = lastCachedTx;

    self._streamAddressSummary(address, options, function(err, tx) {

      if(err)
          return log.error(err);

      if(tx) {
        count++;
        self._aggregateAddressSummaryResult(tx, address, result, options);
        
        if(tx.confirmations) {
          lastTx = tx.txid();
          lastBlock = tx.blockhash;
        }
      }

      if(count >= MAX_TX_QUERY_LIMIT_SUMMARY) {//stop quering db when limit reached
        options.flag_stop = true;
        result.incomplete = true;
      }
      
      streamer(null, tx);

    }, function(err) {

      if (err) {
        return callback(err);
      }

      result.balanceSat = parseInt(result.balanceSat.toFixed());
      result.totalReceivedSat = parseInt(result.totalReceivedSat.toFixed());
      result.totalSentSat = parseInt(result.totalSentSat.toFixed());
      result.txApperances = parseInt(result.txApperances.toFixed());
      result.unconfirmedBalanceSat = parseInt(result.unconfirmedBalanceSat.toFixed());
      result.unconfirmedTxApperances = parseInt(result.unconfirmedTxApperances.toFixed());

      result.balance = Unit.fromSatoshis(result.balanceSat).toBTC();
      result.totalReceived = Unit.fromSatoshis(result.totalReceivedSat).toBTC();
      result.totalSent = Unit.fromSatoshis(result.totalSentSat).toBTC();
      result.unconfirmedBalance = Unit.fromSatoshis(result.unconfirmedBalanceSat).toBTC();

      result.lastItem = lastTx;

      callback(null, result);
    
      //store in cache if needed
      if(useCache) {
        if(result.incomplete) //full summary needs to be calculated in background
          self._cacheSummaryInBackground(address, lastTx, lastBlock, result);
        else if (!_.isUndefined(lastCachedTx) && !_.isUndefined(lastTx) 
          && lastTx != lastCachedTx && !self._cacheInstance.has(address))  //update cache if needed
            self._storeCache(address, lastTx, lastBlock, result);
      }

    });

  })

}

AddressService.prototype._cacheInstance = new Set();
AddressService.prototype._cacheSummaryInBackground = function(address, lastTx, lastBlock, result){
  const self = this;

  if(self._cacheInstance.has(address))
    return;

  self._cacheInstance.add(address);

  const cache = {
    balanceSat: result.balanceSat,
    totalReceivedSat: result.totalReceivedSat,
    totalSentSat: result.totalSentSat,
    txApperances: result.txApperances,
    unconfirmedBalanceSat: 0, //unconfirmed (mempool) values should not be cached
    unconfirmedTxApperances: 0
  }; 
  const options = { queryMempool: false, after: lastTx, noTxList: true };

  self._streamAddressSummary(address, options, function(err, tx) {

    if(err)
      return log.error(err);

    if(tx) {
      self._aggregateAddressSummaryResult(tx, address, cache, options);
      if(tx.confirmations){
        lastTx = tx.txid();
        lastBlock = tx.blockhash;
      }
    }

  }, function(err) {

    if (err) 
      return log.error(err);

    cache.balanceSat = parseInt(cache.balanceSat.toFixed());
    cache.totalReceivedSat = parseInt(cache.totalReceivedSat.toFixed());
    cache.totalSentSat = parseInt(cache.totalSentSat.toFixed());
    cache.txApperances = parseInt(cache.txApperances.toFixed());

    if(!_.isUndefined(lastTx))
      self._storeCache(address, lastTx, lastBlock, cache);

    self._cacheInstance.delete(address); //remove from running instance

  });
  
}

AddressService.prototype._storeCache = function(address, lastCacheTx, lastCacheBlock, result, callback) {
  const self = this;
  var key = self._encoding.encodeAddressCacheKey(address);  
  var value = self._encoding.encodeAddressCacheValue(lastCacheTx, lastCacheBlock, result.balanceSat, result.totalReceivedSat, result.totalSentSat, result.txApperances)
  
  if(!_.isFunction(callback)) //if callback is not passed, call a empty function
    callback = () => null;

  self._db.put(key, value, callback);
}

AddressService.prototype._loadCache = function(address, result, useCache, callback) {
  const self = this;

  if(!useCache) //skip if useCache is false (cases like 'after' and/or 'before' parameter is used by client)
    return callback();

  var key = self._encoding.encodeAddressCacheKey(address);
  self._db.get(key, function(err, value) {

    if (err) {
      return callback(err);
    }
    if (!value) {
      return callback();
    }
      
    var addressCache = self._encoding.decodeAddressCacheValue(value);

    var lastCacheTx = addressCache.lastTx, lastCacheBlock = addressCache.lastBlock

    self._block.getBlock(lastCacheBlock, function(err, block) {
      
      if(err) {
        return callback(err);
      }

      if (!block) { //block not found, probably removed in reorg.
        //delete the existing cache and recalc values freshly
        self._deleteCache(address, function() {
          callback();
        });

      } else {

        //values are in satoshis
        result.balanceSat = addressCache.balance;
        result.totalReceivedSat = addressCache.received;
        result.totalSentSat = addressCache.sent;
        result.txApperances = addressCache.txApperances;
      
        callback(null, lastCacheTx);
      }

    })

  });
}

AddressService.prototype._deleteCache = function(address, callback) {
  const self = this;
  var key = self._encoding.encodeAddressCacheKey(address);

  if(!_.isFunction(callback)) //if callback is not passed, call a empty function
    callback = () => null;

    self._db.del(key, callback);

}

AddressService.prototype._setOutputResults = function(tx, address, result) {

  for(var j = 0; j < tx.outputs.length; j++) {

    var output = tx.outputs[j];

    if (utils.getAddress(output, this._network) !== address) {
      continue;
    }

    result.txApperances++;
    result.totalReceivedSat += output.value;
    result.balanceSat += output.value;

    if (tx.confirmations === 0) {
      result.unconfirmedTxApperances++;
      result.unconfirmedBalanceSat += output.value;
    }

  }
  return result;

};

AddressService.prototype._setInputResults = function(tx, address, result) {
  for(var i = 0; i < tx.inputs.length; i++) {

    var input = tx.inputs[i];
    if (utils.getAddress(input, this._network) !== address) {
      continue;
    }

    result.totalSentSat += tx.__inputValues[i];
    result.balanceSat -= tx.__inputValues[i];

    if (tx.confirmations === 0) {
      result.unconfirmedBalanceSat -= tx.__inputValues[i];
    }

  }
};

AddressService.prototype._getAddressSummaryResult = function(txs, address, result, options) {

  var self = this;

  for(var i = 0; i < txs.length; i++) {
    var tx = txs[i];

    self._setOutputResults(tx, address, result);
    self._setInputResults(tx, address, result);

    if (!options.noTxList) {
      if (!result.transactions)  {
        result.transactions = [];
      }
      result.transactions.push(tx.txid());
    }

  }

  return result;
};

AddressService.prototype._getOccurrenceCount = function(tx, address) {
  let count = 0;

  for(var i = 0; i < tx.inputs.length; i++) {

    var input = tx.inputs[i];

    if(utils.getAddress(input, this._network) === address)
      count++;

  }

  for(var j = 0; j < tx.outputs.length; j++) {

    var output = tx.outputs[j];

    if(utils.getAddress(output, this._network) === address)
      count++;

  }

  return count;

}

AddressService.prototype._getOutputResults = function(tx, address) {

  let value = 0;

  for(var j = 0; j < tx.outputs.length; j++) {

    var output = tx.outputs[j];

    if (utils.getAddress(output, this._network) === address) 
      value += output.value;

  }

  return value;

};

AddressService.prototype._getInputResults = function(tx, address) {
  
  let value = 0;

  for(var i = 0; i < tx.inputs.length; i++) {

    var input = tx.inputs[i];

    if (utils.getAddress(input, this._network) === address) 
      value += tx.__inputValues[i];

  }

  return value;

};

AddressService.prototype._aggregateAddressSummaryResult = function (tx, address, result, options) {
  
  var self = this;

  let output_val = self._getOutputResults(tx, address);
  let input_val = self._getInputResults(tx, address);
  
  //aggregate the result

  if(tx.confirmations) {

    result.txApperances++;

    result.totalReceivedSat += output_val;
    result.balanceSat += output_val;
  
    result.totalSentSat += input_val;
    result.balanceSat -= input_val;
  
  } else {
    result.unconfirmedTxApperances++;
    result.unconfirmedBalanceSat += output_val;
    result.unconfirmedBalanceSat -= input_val;
  }

    if (!options.noTxList) {

      if (!result.transactions)  {
        result.transactions = [];
      }

      let txid = tx.txid();
      if(!result.transactions.includes(txid)) {  //push txid only if its not in the array
        
        result.transactions.unshift(txid); //using unshift, so that recent tx (low confirmation) are at front
        
        if(result.transactions.length > MAX_TX_QUERY_LIMIT_SUMMARY)
          result.transactions.pop(); //pop the oldest tx in list (when list limit is maxed out)
      
        }

    }

}

AddressService.prototype.getAddressUnspentOutputs = function(address, options, callback) {

  var self = this;

  options = options || {};
  options.from = options.from || 0;
  options.to = options.to || 0xffffffff;

  if (_.isUndefined(options.queryMempool)) {
    options.queryMempool = true;
  }

  var results = [];

  var start = self._encoding.encodeUtxoIndexKey(address);
  var final = new Buffer(new Array(73).join('f'), 'hex');
  var end = Buffer.concat([ start.slice(0, -36), final ]);

  var criteria = {
    gte: start,
    lt: end
  };

  async.waterfall([

    // query the mempool if necessary
    function(next) {

      if (!options.queryMempool) {
        return next(null, []);
      }

      self._mempool.getTxidsByAddress(address, 'output', next);
    },

    // if mempool utxos, then add them first
    function(mempoolTxids, next) {

      if (mempoolTxids.length <= 0) {
        return next();
      }

      async.eachLimit(mempoolTxids, 4, function(id, next) {

        self._mempool.getMempoolTransaction(id.txid, function(err, tx) {

          if (err || !tx) {
            return next(err || new Error('Address Service: missing tx: ' + id.txid));
          }

          results = results.concat(self._getMempoolUtxos(tx, address));
          next();

        });

      });

      next();
    },

    function(next) {

      var utxoStream = self._db.createReadStream(criteria);
      var streamErr;

      utxoStream.on('end', function() {

        if (streamErr) {
          return callback(streamErr);
        }

        results = utils.orderByConfirmations(results);
        next(null, results);

      });

      utxoStream.on('error', function(err) {
        streamErr = err;
      });

      utxoStream.on('data', function(data) {

        if(results.length >= MAX_TX_QUERY_LIMIT_UTXO) { //Max array limit reached, end response
          utxoStream.emit('end'); 
          return;
        }

        var key = self._encoding.decodeUtxoIndexKey(data.key);
        var value =  self._encoding.decodeUtxoIndexValue(data.value);

        results.push({
          address: address,
          txid: key.txid,
          vout: key.outputIndex,
          ts: value.timestamp,
          scriptPubKey: value.script.toString('hex'),
          amount: Unit.fromSatoshis(value.satoshis).toBTC(),
          height: value.height,
          satoshis: value.satoshis,
          confirmations: self._block.getTip().height - value.height + 1
        });

      });
    }
  ], callback);

};

AddressService.prototype._getMempoolUtxos = function(tx, address) {

  var results = [];

  for(var i = 0; i < tx.outputs.length; i++) {

    var output = tx.outputs[i];

    if (utils.getAddress(output, this._network) !== address) {
      continue;
    }

    results.push({
      address: address,
      txid: tx.txid(),
      vout: i,
      scriptPubKey: output.script.toRaw().toString('hex'),
      amount: Unit.fromSatoshis(output.value).toBTC(),
      height: null,
      satoshis: output.value,
      confirmations: 0
    });
  }

  return results;
};

AddressService.prototype.getAPIMethods = function() {
  return [
    ['getAddressHistory', this, this.getAddressHistory, 2],
    ['getAddressSummary', this, this.getAddressSummary, 1],
    ['getAddressUnspentOutputs', this, this.getAddressUnspentOutputs, 1]
  ];
};

AddressService.prototype.start = function(callback) {

  var self = this;

  this._db.getPrefix(this.name, function(err, prefix) {
    if(err) {
      return callback(err);
    }
    self._encoding = new Encoding(prefix);
    callback();
  });
};

AddressService.prototype.stop = function(callback) {
  setImmediate(callback);
};

AddressService.prototype._getTxidStream = function(address, options) {

  var criteria = {};

  if(options.after) 
    criteria.gt = this._encoding.encodeAddressIndexKey(address, options.start, options.after, 0xffffffff, 1, 0xffffffff); //0xffffffff is for getting after the txid
  else 
    criteria.gte = this._encoding.encodeAddressIndexKey(address, options.start);
  
  if(options.before)
    criteria.lt = this._encoding.encodeAddressIndexKey(address, options.end, options.before); //get before the txid
  else
    criteria.lte = this._encoding.encodeAddressIndexKey(address, options.end, Array(65).join('f'), 0xffffffff, 1, 0xffffffff);
  
  //reverse option can be used explictly when latest tx are required
  if(options.reverse)
    criteria.reverse = true;
  // txid stream
  var txidStream = this._db.createKeyStream(criteria);

  txidStream.on('close', function() {
    txidStream.unpipe();
  });

  return txidStream;
};

//(used by old fn)
AddressService.prototype._getAddressTxHistory = function(options, callback) {

  var self = this;

  // slice the txids based on pagination needs
  var ids = options.txIdList.slice(options.from, options.to);

  // go and get the actual txs
  async.mapLimit(ids, 4, function(id, next) {

    if (id.height === 0xffffffff) {
      return self._mempool.getMempoolTransaction(id.txid, function(err, tx) {

        if (err || !tx) {
          return next(err || new Error('Address Service: could not find tx: ' + id.txid));
        }

        self._transaction.setTxMetaInfo(tx, options, next);

      });
    }

    self._transaction.getDetailedTransaction(id.txid, options, next);

  }, callback);

};

//(used by old fn)
AddressService.prototype._getAddressTxidHistory = function(address, options, callback) {
  var self = this;

  options = options || {};
  options.start = options.start || 0;
  options.end = options.end || 0xffffffff;

  var results = [];

  if (_.isUndefined(options.queryMempool)) {
    options.queryMempool = true;
  }

  async.waterfall([

    // query the mempool for relevant txs for this address
    function(next) {

      if (!options.queryMempool) {
        return next(null, []);
      }

      self._mempool.getTxidsByAddress(address, 'both', next);
    },

    // add the meta data such as input values, etc.
    function(mempoolTxids, next) {

      if (mempoolTxids.length <= 0) {
        return next();
      }

      results = mempoolTxids;
      next();
    },
    // stream the rest of the confirmed txids out of the address index
    function(next) {

      var txIdTransformStream = new Transform({ objectMode: true });

      txIdTransformStream._flush = function(callback) {
        txIdTransformStream.emit('end');
        callback();
      };

      txIdTransformStream.on('error', function(err) {
        log.error('Address Service: txstream err: ' + err);
        txIdTransformStream.unpipe();
      });

      txIdTransformStream.on('end', function() {
        options.txIdList = options.txIdList.concat(results);
        next();
      });

      txIdTransformStream._transform = function(chunk, enc, callback) {
        var txInfo = self._encoding.decodeAddressIndexKey(chunk);

        if(results.length >= MAX_TX_QUERY_LIMIT_HISTORY) { //Max array limit reached, end response
          txIdTransformStream.emit('end'); 
          return;
        }

        if(!results.some(r => r.txid == txInfo.txid)) //add txid to array only if its not already there
          results.push({ txid: txInfo.txid, height: txInfo.height });

        callback();
      };

      var txidStream = self._getTxidStream(address, options);
      txidStream.pipe(txIdTransformStream);

    }
  ], callback);

};

AddressService.prototype._streamAddressSummary = function(address, options, streamer, callback) {
  var self = this;

  options = options || {};
  options.start = options.start || 0;
  options.end = options.end || 0xffffffff;

  //options.from = options.from || 0; //Deprecated, use `after` and `before` option
  //options.to = options.to || 0xffffffff; //Deprecated, use `after` and `before` option

  if (_.isUndefined(options.queryMempool)) {
    options.queryMempool = true;
  }

  if (_.isUndefined(options.mempoolOnly)) {
    options.mempoolOnly = false;
  }

  if (_.isUndefined(options.reverse)) {
    options.reverse = false;
  }

  //declare the queue to process tx data
  var tmpTxList = {}; //store processed txid temporarily to ignore duplication

  var q = async.queue(function(id, cb) {

    //duplication finding
    if(id.txid in tmpTxList){

      tmpTxList[id.txid][0]++;
      
      if(tmpTxList[id.txid][1] !== null && tmpTxList[id.txid][0] >= tmpTxList[id.txid][1]) //all duplications are found for this txid
        delete tmpTxList[id.txid];
      
      return cb();

    } else tmpTxList[id.txid] = [1, null];

    if (id.height === 0xffffffff) {

      return self._mempool.getMempoolTransaction(id.txid, function(err, tx) {

        if (err || !tx) {
          return cb(err || new Error('Address Service: could not find tx: ' + id.txid));
        }
        self._transaction.setTxMetaInfo(tx, options, cb);

      });

    }

    self._transaction.getDetailedTransaction(id.txid, options, cb);

  }, 1);

  //q.pause(); //pause and wait until queue is set (not needed)

  function chunkCallback(err, tx){

    if(q.killed || (!err && !tx)) //no error or tx data (duplicate calls will have empty tx value) 
      return; 

    if(tx){
      let txid = tx.txid();
      tmpTxList[txid][1] = self._getOccurrenceCount(tx, address);

      if(tmpTxList[txid][0] >= tmpTxList[txid][1]) //all duplications are found for this txid
        delete tmpTxList[txid];
    }

    streamer(err, tx);

    if((err || options.flag_stop) && !q.killed){

      q.kill();
      q.killed = true;

      return callback();
    }

  }

    const waterfall_array = [];

    waterfall_array.push(
    //Find start height if `after` option is passed
    function parse_after_id(next){

      if(_.isUndefined(options.after)) {
        return next();
      }
      
      self._transaction.getTransaction(options.after, options, function(err, tx) {

        if(tx && tx.confirmations && tx.height >= options.start) {
  
          options.start = tx.height;

        } else { 

          delete options.after;

        } 

        next();
        
      });

    });

    waterfall_array.push(
    //Find end height if `before` option is passed
    function parse_before_id(next){
  
      if(_.isUndefined(options.before)) {
        return next();
      }
      
      self._transaction.getTransaction(options.before, options, function(err, tx) {

        if(tx && tx.confirmations && tx.height <= options.end) {
  
          options.end = tx.height;

        } else { 

          delete options.before;

        } 

        next();
        
      });

    });

    // stream the confirmed txids out of the address index
    function query_confirmed_txids(next) {

      if (options.mempoolOnly) {  //Option to query from mempool only (ie, unconfirmed txs only)
        return next();
      }

      var txIdTransformStream = new Transform({ objectMode: true });

      txIdTransformStream._flush = function(cb) {
        txIdTransformStream.emit('end');
        cb();
      };

      txIdTransformStream.on('error', function(err) {
        log.error('Address Service: txstream err: ' + err);
        txIdTransformStream.unpipe();
      });

      txIdTransformStream.on('end', function() {
        next();
      });

      txIdTransformStream._transform = function(chunk, enc, cb) {

        if(options.flag_stop)//stop data query          
          return txIdTransformStream.unpipe();

        var txInfo = self._encoding.decodeAddressIndexKey(chunk);
        q.push({ txid: txInfo.txid, height: txInfo.height }, chunkCallback);
        
        cb();
      };

      var txidStream = self._getTxidStream(address, options);
      txidStream.pipe(txIdTransformStream);
      
    }

    // query the mempool for relevant txs for this address
    function query_mempool_txids(next) {

      if (!options.queryMempool || !_.isUndefined(options.before)) { //if queryMempool=false or options.before is given a valid value, then do not query mempool
        return next();
      }

      self._mempool.getTxidsByAddress(address, 'both', function(err, mempoolTxids) {

        if (mempoolTxids.length <= 0) {
          return next();
        }
  
        mempoolTxids.map(id => q.push(id, chunkCallback));
        next();
      });

    }

    if(options.reverse){ //when queried txs in reverse key order, mempool first then confirmed
      waterfall_array.push(query_mempool_txids);
      waterfall_array.push(query_confirmed_txids);
    } else {  //when queried tx in key order, confirmed tx 1st, then mempool
      waterfall_array.push(query_confirmed_txids);
      waterfall_array.push(query_mempool_txids);
    }

    waterfall_array.push(
    //wait for queue to complete
    function end_fall(next) {

      if(!q.started || q.idle()) //No tx in query (or) already finished querying
        return next();

      else
        q.drain = () => next();

    });

  async.waterfall(waterfall_array, callback);

}

AddressService.prototype._removeBlock = function(block, callback) {

  var self = this;

  async.mapSeries(block.txs, function(tx, next) {

    self._removeTx(tx, block, next);

  }, callback);

};

AddressService.prototype._removeTx = function(tx, block, callback) {

  var self = this;
  var operations = [];

  async.parallelLimit([

    function(next) {
      async.eachOfSeries(tx.inputs, function(input, indext, next) {
        self._removeInput(input, tx, block, index, function(err, ops) {
          if(err) {
            return next(err);
          }
          operations = operations.concat(ops);
          next();
        });
      }, next);
    },

    function(next) {
      async.eachOfSeries(tx.outputs, function(output, index, next) {
        self._removeOutput(output, tx, block, index, function(err, ops) {
          if(err) {
            return next(err);
          }
          operations = operations.concat(ops);
          next();
        });
      }, next);
    }

  ], 4, function(err) {

    if(err) {
      return callback(err);
    }

    callback(null, operations);

  });

};

AddressService.prototype._removeInput = function(input, tx, block, index, callback) {

  var self = this;
  var address = input.getAddress();

  var removalOps = [];

  if (!address) {
    return callback();
  }

  address.network = self._network;
  address = address.toString(self._network);

  assert(block && block.__ts && block.__height, 'Missing block or block values.');

  removalOps.push({
    type: 'del',
    key: self._encoding.encodeAddressIndexKey(address, block.__height, tx.txid(), index, 1, block.__ts)
  });

  // look up prev output of this input and put it back in the set of utxos
  self._transaction.getTransaction(input.prevout.txid(), function(err, _tx) {

    if (err) {
      return callback(err);
    }

    assert(_tx, 'Missing prev tx to insert back into the utxo set when reorging address index.');
    assert(_tx.__height && _tx.__inputValues && _tx.__timestamp, 'Missing tx values.');

    removalOps.push({
      type: 'put',
      key: self._encoding.encodeUtxoIndexKey(address, _tx.txid(), input.prevout.index),
      value: self._encoding.encodeUtxoIndexValue(
        _tx.__height,
        _tx.__inputValues[input.prevout.index],
        _tx.__timestamp, _tx.outputs[input.prevout.index].script.toRaw())
    });

    callback(null, removalOps);

  });
};

AddressService.prototype._removeOutput = function(output, tx, block, index, callback) {

  var self = this;
  var address = output.getAddress();
  var removalOps = [];

  if (!address) {
    return callback();
  }

  address.network = self._network;
  address = address.toString(self._network);

  assert(block && block.__ts && block.__height, 'Missing block or block values.');

  removalOps.push({
    type: 'del',
    key: self._encoding.encodeAddressIndexKey(address, block.__height, tx.txid(), index, 0, block.__ts)
  });

  //remove the utxo for this output from the collection
  removalOps.push({
    type: 'del',
    key: self._encoding.encodeUtxoIndexKey(address, tx.txid(), index)
  });

  setImmediate(function() {
    callback(null, removalOps);
  });
};

AddressService.prototype.onReorg = function(args, callback) {

  var self = this;

  var oldBlockList = args[1];

  // for every tx, remove the address index key for every input and output
  // for every input record, we need to find its previous output and put it back into the utxo collection
  async.mapSeries(oldBlockList, self._removeBlock.bind(self), function(err, ops) {

    if (err) {
      return callback(err);
    }

   var operations = lodash.compact(lodash.flattenDeep(ops));
    callback(null, operations);
  });

};

AddressService.prototype.onBlock = function(block, callback) {
  var self = this;

  if (self.node.stopping) {
    return callback();
  }

  var operations = [];

  for(var i = 0; i < block.txs.length; i++) {
    var tx = block.txs[i];
    var ops = self._processTransaction(tx, { block: block });
    operations.push(ops);
  }

  operations = lodash.flattenDeep(operations);

  callback(null, operations);
};

AddressService.prototype._processInput = function(tx, input, index, opts) {

  var address = input.getAddress();

  if(!address) {
    return;
  }

  address.network = this._network;
  address = address.toString(this._network);

  var txid = tx.txid();
  var timestamp = this._timestamp.getTimestampSync(opts.block.rhash());

  assert(timestamp, 'Must have a timestamp in order to process input.');

  // address index
  var addressKey = this._encoding.encodeAddressIndexKey(address, opts.block.__height, txid, index, 1, timestamp);

  var operations = [{
    type: 'put',
    key: addressKey
  }];

  // prev utxo
  var rec = {
    type: 'del',
    key: this._encoding.encodeUtxoIndexKey(address, input.prevout.txid(), input.prevout.index)
  };

  operations.push(rec);

  return operations;
};

AddressService.prototype._processOutput = function(tx, output, index, opts) {

  // TODO: if the output is pay to public key, we are reporting this as p2pkh
  // this leads to the spending tx not being properly indexed. Txs that
  // spend p2pk outputs, will not have the public key as part of their input script sig
  var address = output.getAddress();

  if(!address) {
    return;
  }

  address.network = this._network;
  address = address.toString(this._network);

  var txid = tx.txid();
  var timestamp = this._timestamp.getTimestampSync(opts.block.rhash());

  assert(timestamp, 'Must have a timestamp in order to process output.');

  var addressKey = this._encoding.encodeAddressIndexKey(address, opts.block.__height, txid, index, 0, timestamp);

  var utxoKey = this._encoding.encodeUtxoIndexKey(address, txid, index);
  var utxoValue = this._encoding.encodeUtxoIndexValue(
    opts.block.__height,
    output.value,
    timestamp,
    output.script.toRaw()
  );

  var operations = [{
    type: 'put',
    key: addressKey
  }];

  operations.push({
    type: 'put',
    key: utxoKey,
    value: utxoValue
  });

  return operations;

};

AddressService.prototype._processTransaction = function(tx, opts) {

  var self = this;

  var _opts = { block: opts.block };

  var outputOperations = tx.outputs.map(function(output, index) {
    return self._processOutput(tx, output, index, _opts);
  });

  outputOperations = lodash.compact(lodash.flattenDeep(outputOperations));
  assert(outputOperations.length % 2 === 0 &&
    outputOperations.length <= tx.outputs.length * 2,
    'Output operations count is not reflective of what should be possible.');

  var inputOperations = tx.inputs.map(function(input, index) {
    return self._processInput(tx, input, index, _opts);
  });

  inputOperations = lodash.compact(lodash.flattenDeep(inputOperations));

  assert(inputOperations.length % 2 === 0 &&
    inputOperations.length <= tx.inputs.length * 2,
    'Input operations count is not reflective of what should be possible.');

  outputOperations = outputOperations.concat(inputOperations);
  return outputOperations;

};

module.exports = AddressService;
