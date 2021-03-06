var net = require('net'),
  crypto = require('crypto'),
  util = require('util'),
  enableDestroy = require('server-destroy'),
  EventEmitter = require('events').EventEmitter,
  _ = require('underscore'),
  async = require('async'),
  Peer = require('./peer'),
  ratePeer = require('./rating'),
  pjson = require('../package.json');

/**
 * Creates new Network object
 * @class Implements Ethereum's Wire Protocol and provides networking functions.
 * @param {Object} options
 * @param {Number} [options.protocolVersion=1] The network version
 * @param {String} [options.publicIp] The public ip address of this instance
 * @param {Object} [options.caps] A hash containing the capbilities of this node and their corrisponding version numbers
 * @param {Number} [options.timeout=20000] The length of time in milliseconds to wait for a peer to response after connecting to it
 * @param {Number} [options.maxPeers=10] The max number of peer the network will try to connect to
 * @param {String} [options.clientId] Specifies the client software identity, as a human-readable string
 * @param {String} [options.nodeId] the Unique Identity of the node and specifies a 512-bit hash that identifies this node.
 * @property {Array.<Peer>} peers an array of connected peers
 * @property {Array.<Peer>} knownPeers an array of peers the server knows about but is not connected to. The server uses this list to replace peers that disconnect.
 */
var Network = exports = module.exports = function(options) {

  var self = this;

  //Register as event emitter
  EventEmitter.call(this);

  //setup defaults
  var optionDefaults = {
    protocolVersion: 2,
    timeout: 20000, //10 seconds
    maxPeers: 10,
    clientId: 'Ethereum Node.js/' + pjson.version,
    networkID: 0,
    db: 0
  };

  options = options ? options : {};
  _.defaults(options, optionDefaults);
  _.defaults(this, options);

  if (!this.id) {
    //generate a node id
    var hash = crypto.createHash('sha512');
    hash.update((Math.random())
      .toString());

    this.id = new Buffer(hash.digest('hex'), 'hex');
  }

  this._peers = {}; //list of peer connected to
  this._peersList = {}; //list of known but not connected to peers
  this._connectingPeers = {}; //open socket connections that have not sent the 'Hello' packet yet
  this._stopping = false;
  this._loadedDefs = {}; //the subprotocols definitions that we have loaded
  this._parseFuncs = []; //maps the message codes to parsing definitions
  this._messageOffsets = {};
  this.capabilities = {};
  this.port = 0;

  Object.defineProperties(this, {
    knownPeers: {
      // Load Initial Peers if Db is given into memory
      get: function() {
        if(self.db && _.isEmpty(self._peersList)){
          db.createReadStream()
            .on('data',function(data) {
                self._peersList[data.key] = data.value;
            })
            .on('error', console.error)
            .on('end',function() {
              return _.values(self._peersList);
            });
        } else {
          return _.values(self._peersList);
        }
      },
      // Store Peers in Leveldb if Given
      store: function(peer,id) {
        if(self.db){
          var ws = db.createWriteStream()
            .on('error',console.error)
            .on('close',function() {
              self._peersList[id] = peer;
            });

          ws.write({
              key: id,
              value: {
                ip: peer.ip,
                port: peer.port,
                rep: peer.rep || 3
              }
            });
          ws.end();
        } else {
          self._peersList[id] = peer;
        }
      },
      // Remove Peer from Db and PeerList
      remove: function(peer, id) {
        if(self.db){
          var ws = db.createWriteStream()
            .on('error',console.error)
            .on('close',function() {
              delete self._peersList[id];
            });

          ws.write({ type: 'del', key: id });
          ws.end();
        } else {
          delete self._peersList[id];
        }
      }
    },
    peers: {
      get: function() {
        return _.values(this._peers);
      }
    }
  });

  this.addDefinition(require('./p2pDefinitions.js'), true);
  Network.definitions.forEach(function(def){
    self.addDefinition(def);
  });

  this.server = net.createServer(this._onConnect.bind(this));
};

//an array of definitions to add to any instatated `Network`
Network.definitions = [];

util.inherits(Network, EventEmitter);

/**
 * Addes a subprotocal definition to devP2P
 * @method addDefinition
 * @param {Object} def the definition to load
 */
Network.prototype.addDefinition = function(def, base) {
  var self = this,
    offset = 16;

  function addParseFuncs(def) {
    var subOffsets = def.offsets;
    var currentOffset;
    var name = def.meta.name;

    if (!name) {
      name = '';
    }

    for (var so in subOffsets) {
      currentOffset = parseInt(so, 16) + offset;

      var packetName = subOffsets[so];
      var parseFunc = def.parse[packetName];

      self._parseFuncs[currentOffset] = parseFunc ? function(pf) {
        return function() {
          return [name, pf.apply(this, arguments)];
        };
      }(parseFunc) : function() {
        return [name, {}];
      };

      self._messageOffsets[name + packetName] = currentOffset;
    }

    Peer.addSubFunctions(def);
    offset = currentOffset;
  }

  //offset should always start as 10 unless we are loading the base DEV2P2 definition
  if (!base) {
    this.capabilities[def.meta.name] = def.meta.version;
    this._loadedDefs[def.meta.name] = def;

    //recaculate the offsets
    Object.keys(this.capabilities).sort().forEach(function(subPro) {
      var def = self._loadedDefs[subPro];
      addParseFuncs(def);
    });

  } else {
    offset = 0;
    addParseFuncs(def);
  }

};

/**
 * start the server
 * @method listen
 * @param {Number} [port=30303] The hostname or IP address the server is bound to. Defaults to 0.0.0.0 which means any available network
 * @param {String} [host='0.0.0.0'] The TPC port the server is listening to. Defaults to port 30303
 */
Network.prototype.listen = function(port, host, cb) {
  var self = this;
  this.host = host ? host : '0.0.0.0';
  this.port = port ? port : 30303;
  this.server.listen(this.port, this.host, function() {
    self._listening = true;
    if (_.isFunction(cb)) {
      cb();
    }
  });
  enableDestroy(this.server);
};

/**
 * connects to a peer
 * @method connect
 * @param {Number} port the port of the peer
 * @param {String} host the hostname or IP of the peer
 * @param {Function} cb the callback
 */
Network.prototype.connect = function(port, host, cb) {
  var socket = new net.Socket(),
    self = this,
    _cb;

  if (!cb) {
    _cb = function() {};
  } else {
    _cb = function(err) {
      cb(err);
      cb = function() {};
    };
  }


  function onError(e) {
    socket.destroy();
    _cb(e);
  }

  socket.setTimeout(this.timeout);
  socket.on('timeout', onError);
  socket.on('error', onError);
  socket.on('connect', function() {
    self._onConnect(socket);
    _cb();
  });
  socket.connect(port, host);
  return socket;
};

//creates a new peer object and adds it to the peer hash
Network.prototype._onConnect = function(socket) {

  if (!this.publicIp) {
    this.publicIp = socket.localAddress;
  }

  //save the socket until it full connects
  socket.id = socket.remoteAddress + ':' + socket.remotePort;
  this._connectingPeers[socket.id] = socket;

  var peer = new Peer(socket, this),
    self = this;

  //disconnect delete peers
  socket.on('close', function() {
    self.emit('closing', peer);
    //delete refrances to the peer
    delete self._peers[peer.id];
    self._popPeerList();
  });

  peer.on('hello', function(hello) {
    delete self._connectingPeers[socket.id];
    self._peers[hello.id] = peer;
  });

  peer.on('peers', function(peers) {
    for (var i = 0; i < peers.length; i++) {
      //save only the peers that are listening and to peers we are not already connected to
      if (peers[i].port !== 0 && !self._peers[peers[i].id] && self.id.toString('hex') !== peers[i].id) {
        //create uid and save to peerlist
        self.knownPeers.store(peers[i],peers[i].id);
      }
    }

    //self.broadcastPeers(peersToBroadcast);
    //connects to new peers
    self._popPeerList();
  });

  this.emit('connect', peer);
};

/**
 * stops the tcp server and disconnects any peers
 * @method stop
 * @param {Function} cb the callback
 */
Network.prototype.stop = function(cb) {
  var self = this;
  this._stopping = true;

  for (var peer in this._connectingPeers) {
    self._connectingPeers[peer].end();
  }

  //disconnect all the peers
  async.each(this.peers, function(peer, cb2) {
    peer.socket.once('close', cb2);
    //0x08 Client quitting.
    peer.disconnect(0x08, function() {
      peer.socket.end();
    });
  }, function() {
    //disconnect peers
    if (self._listening) {
      self._listening = false;
      self.server.destroy(cb);
    } else if (cb) {
      cb();
    }
  });
};

//broadcast an array of blocks to the network
Network.prototype.broadcastBlocks = function(blocks, cb) {
  this._broadcast('sendBlocks', blocks, cb);
};

//broadcast an array of transactions to the network
Network.prototype.broadcastTransactions = function(txs, cb) {
  this._broadcast('sendTransactions', txs, cb);
};

Network.prototype.broadcastGetPeers = function(cb) {
  this._broadcast('getPeers', cb);
};

Network.prototype.broadcastPing = function(cb) {
  this._broadcast('sendPing', cb);
};

Network.prototype.broadcastGetChain = function(parents, count, cb) {
  this._broadcast('sendGetChain', parents, count, cb);
};

Network.prototype.broadcastGetTransactions = function(cb) {
  this._broadcast('sendGetTransactions', cb);
};

Network.prototype.broadcastDisconnect = function(reason, cb) {
  this._broadcast('sendDisconnect', reason, cb);
};

Network.prototype.broadcastPeers = function(peers, cb) {
  this._broadcast('peers', peers, cb);
};

Network.prototype.broadcastNewBlock = function(block, td, cb) {
  this._broadcast('sendNewBlock', block, td, cb);
};

/**
 * broadcast messages to the network
 * @method _broadcast
 * @param {String} functionName - one peer's sending functions
 * @param {..} - the argments for the function
 * @param cb - a callback
 * @private
 */
Network.prototype._broadcast = function() {
  var args = Array.prototype.slice.call(arguments),
    cb,
    fn = args.shift();

  if (_.isFunction(arguments[arguments.length - 1])) {
    cb = arguments.pop();
  }

  async.each(this.peers, function(peer, cb2) {
    var fargs = args.slice();
    fargs.push(cb2);
    peer[fn].apply(peer, fargs);
  }, cb);
};

/**
 * Pops peers off the peer list and connects to them untill we reach maxPeers
 * or we run out of peer in the peer list
 * @private
 */
Network.prototype._popPeerList = function() {

  var openSlots = this.maxPeers - this.peers.length,
    self = this;

  if (this.knownPeers.length > 0 && openSlots > 0 && !this._stopping) {
    var peers = this.knownPeers.get().splice(0, openSlots);
    async.each(peers, function(peer, done) {
      delete self._peersList[peer.id];

      // Rate Peer on Connect
      self.connect(peer.port, peer.publicIp, function(err){
        if(err instanceof Error){
          ratePeer(peer).downvote(function(peer, id) {
            if(id)
              self.knownPeers.remove(peer, id)
          })
        } else {
          ratePeer(peer).upvote();
        }
      });
      
    });
  }
};
