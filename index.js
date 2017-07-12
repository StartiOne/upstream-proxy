
'use strict';

/**
 * Imports
 * ...wait for v8 to implement es6 style
 * import net from 'net';
 * import sni from 'sni';
*/
const net = require('net');
const xpipe = require('xpipe');
const HttpMessageParser = require('./HttpMessageParser');
const Transform = require('stream').Transform;

/**
 * Creates a new upstream proxy instance.
 * @class
 */
class UpstreamProxy {

  /**
    * @constructs UpstreamProxy server
    * @param {Object} config - Sets data for calculating the routes.
    * @param {Object} callbacks - Sets callbacks for external error handling.
    * @return {Object}
    */
  constructor(config = {}, callbacks = {}) {

    this.active = false;
    this.id = 0;
    this.symId = Symbol('id');
    this.symHostHeader = Symbol('host_header');
    this.host_headers = {};
    this.sockets = new Map();
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    this.routeResolver = (message) => {
      let hostHeader = message.headers.host.split(':')[0];
      let route = this.routes.get(hostHeader);
      if (!route) {
        route = this.routes.get('*');
      }
      return route;
    }

    this.status_codes = new Map([
      [400, 'Bad Request'],
      [404, 'Not Found'],
      [500, 'Internal Server Error'],
      [502, 'Bad Gateway'],
      [503, 'Service Unavailable']
    ]);

    try {
      this.config = config;
      this.routes = this._generateRoutesMap(this.config);
    }
    catch(e) {};

    try {
      this.callbacks = callbacks;
    }
    catch(e) {};

    let server = net.createServer((socket) => this._handleConnection(socket));
    server.start = () => this.start();
    server.stop = () => this.stop();
    server.getStatus = () => this.getStatus();
    server.getConfig = () => this.getConfig();
    server.setConfig = (config) => this.setConfig(config);
    server.getRoutes = () => this.getRoutes();
    server.getCallbacks = () => this.getCallbacks();
    server.setCallbacks = (callbacks) => this.setCallbacks(callbacks);
    server.disconnectClients = (host) => this.disconnectClients(host);
    server.disconnectAllClients = () => this.disconnectAllClients();
    server.addRequestInterceptor = (fn) => this.addRequestInterceptor(fn);
    server.addResponseInterceptor = (fn) => this.addResponseInterceptor(fn);
    server.setRouteResolver = (fn) => this.setRouteResolver(fn);

    return server;
  }

  addRequestInterceptor(fn) {
    this.requestInterceptors.push(fn);
  }

  addResponseInterceptor(fn) {
    this.responseInterceptors.push(fn);
  }

  setRouteResolver(fn) {
    this.routeResolver = fn;
  }

  /**
   * Handles connections from frontend
   * @param {Object} socket
   */
  _handleConnection(socket) {
    if (!this.active) {
      return socket.end(this._httpResponse(503));
    }

    var parser = new HttpMessageParser('request');

    socket.once('data', (buffer) => {
      var ret = parser.execute(buffer, 0, buffer.length);
      if (ret instanceof Error) {
        parser.emit('error');
      }
    });

    parser.once('headers', (request) => {
      this._handleRequest(socket, request);
    });

    parser.on('error', () => {
      socket.end(this._httpResponse(400));
    });

    socket.once('error', (err) => {
      socket.end();
    });
  }

  /**
   * Handles data from connection handler
   * @param {Object} socket
   * @param {Buffer} data
   */
  _handleRequest(socket, message) {
    let host_header = '*';
    let route = this.routeResolver(message);
    if (!route) {
      return socket.end(this._httpResponse(404));
    }
    host_header = route.host;

    let backend = new net.Socket();

    backend.once('error', (err) => {
      backend.destroy();
      const status = 503;
      if (this.callbacks[status]) {
        this.callbacks[status](socket, host_header);
      } else {
        socket.end(this._httpResponse(status));
      }
    });

    backend.on('connect', () => {
      this._addConnection(socket, host_header);
      socket.on('error', () => { this._removeConnection(socket, backend) });
      backend.on('close', () => { this._removeConnection(socket, backend) });
      backend.write(this._makeBufferFromHttpMessage(this._handleRequestInterceptors(message)));
      let handler = {
        protocol: 'http'
      }
      socket
        .pipe(this._makeHttpParserStream('request', handler))
        .pipe(backend)
        .pipe(this._makeHttpParserStream('response', handler))
        .pipe(socket);
    });

    backend.connect(route);
  }

  _makeBufferFromHttpMessage(message) {
    let lines = []
    let httpVersion = 'HTTP/' + message.versionMajor + '.' + message.versionMinor
    if (message.statusCode) {
      lines.push(httpVersion + ' ' + message.statusCode + ' ' + message.statusMessage)
    } else {
      lines.push(message.method + ' ' + message.url + ' ' + httpVersion)
    }
    for (var headerKey in message.headers) {
      lines.push(headerKey + ': ' + message.headers[headerKey])
    }
    return Buffer.from(
      lines.join('\r\n') + '\r\n' + '\r\n',
      'utf-8'
    )
  }

  _makeHttpParserStream (type, handler) {
      let ts = new Transform();
      let chunks = [], len = 0;
      let parser = new HttpMessageParser(type);
      let interceptorMethod = type == 'request' ? '_handleRequestInterceptors' : '_handleResponseInterceptors';

      ts._transform = function _transform (chunk, enc, cb) {
        if (handler.protocol == 'http') {
          let ret = parser.execute(chunk, 0, chunk.length)
          if (ret instanceof Error) {
            parser.emit('error')
          }
          len += chunk.length;
          chunks.push(chunk);
        } else {
          ts.push(chunk);
        }
        cb(null);
      };

      ts._flush = function _flush(cb) {
        if (chunks.length) {
          let buffer = Buffer.concat(chunks, len);
          ts.push(buffer);
          chunks = [];
          len = 0;
        }
        cb(null);
      }

      parser.on('headers', (message) => {
        chunks = [];
        len = 0;
        ts.push(this._makeBufferFromHttpMessage(this[interceptorMethod](message)));
        if (message.statusCode === 101) {
          handler.protocol = message.headers.upgrade;
        }
      });

      parser.on('body', (buffer, offset, length) => {
        chunks = [];
        len = 0;
        buffer = offset ? buffer.slice(offset) : buffer;
        ts.push(buffer);
      });

      parser.on('error', function () {
        ts._flush(function () {});
      });

      return ts;
  }

  _handleRequestInterceptors(request) {
    for (var fn of this.requestInterceptors) {
      fn(request);
    }
    return request;
  }

  _handleResponseInterceptors(response) {
    for (var fn of this.responseInterceptors) {
      fn(response);
    }
    return response;
  }

  /**
   * Adds socket to internal frontend connection tracking
   * @param {Object} socket
   * @param {string} host_header
   */
  _addConnection(socket, host_header) {
    this.id++;
    socket[this.symId] = this.id;
    socket[this.symHostHeader] = host_header;
    if (! this.host_headers[host_header]) {
      this.host_headers[host_header] = new Map();
    }
    this.host_headers[host_header].set(this.id, true);
    this.sockets.set(this.id, socket);
  }

  /**
   * Removes socket from internal frontend connection tracking
   * @param {Object} socket
   * @param {Object} backend
   */
  _removeConnection(socket, backend) {
    this.host_headers[socket[this.symHostHeader]].delete(socket[this.symId]);
    this.sockets.delete(socket[this.symId]);
    socket.end();
    socket.unref();
    backend.end();
  }

  /**
   * Generates routes map
   * @param {Object} config
   * @return {Map}
   */
  _generateRoutesMap(config) {
    let routes = new Map();
    if (config instanceof Array) {
      for (let obj of config) {
        if (obj.endpoint && obj.endpoint.path) {
          obj.endpoint.path = xpipe.eq(obj.endpoint.path);
        }
        let hosts = obj.hostnames || [];
        for (let host of hosts) {
          if (obj.endpoint) {
            routes.set(host, obj.endpoint);
          }
        }
      }
    }
    return routes;
  }

  /**
   * Closes frontend connections
   * @param {Array} list_of_ids
   * @return {number}
   */
  _closeFrontendConnections(list_of_ids) {
    let i = 0;
    for (let id of list_of_ids) {
      try {
        this.sockets.get(id).end();
        this.sockets.delete(id);
        i++;
      } catch (e) {
        //console.log(e);
      }
    }
    return i;
  }

  /**
   * Generates client response
   * @param {number} nr
   * @return {string}
   */
  _httpResponse(nr) {
    let reason_phrase = this.status_codes.get(nr);
    if (!reason_phrase) {
      return 'HTTP/1.1 500 Internal Server Error\r\n\r\n';
    }
    return 'HTTP/1.1 ' + nr + ' ' + reason_phrase + '\r\n\r\n';
  }

  /**
   * Returns current configuration
   * @return {Object}
   */
  getConfig() {
    return this.config;
  }

  /**
   * Overwrites current configuration
   * @param {Object} config - Sets data for calculating the routes.
   * @param {Array} config.frontend_connectors - Describes frontend connectors.
   * @param {Array} config.backend_connectors - Describes backend connectors.
   */
  setConfig(config = {}) {
    try {
      this.config = config;
      this.routes = this._generateRoutesMap(this.config);
      return 'OK';
    } catch (e) {
      return 'ERROR: ' + e.message;
    }
  }

  /**
   * Returns current routes
   * @return {Map}
   */
  getRoutes() {
    return this.routes;
  }

  /**
   * Returns current callbacks
   * @return {Object}
   */
  getCallbacks() {
    return this.callbacks;
  }

  /**
   * Overwrites current callbacks
   * @param {Object} callbacks - Sets callbacks for external error handling.
   */
  setCallbacks(callbacks = {}) {
    try {
      this.callbacks = callbacks;
      return 'OK';
    } catch (e) {
      return 'ERROR: ' + e.message;
    }
  }

  /**
   * Starts routing
   * @return {string}
   */
  start() {
    this.active = true;
    return 'OK';
  }

  /**
   * Stops routing
   * @return {string}
   */
  stop() {
    this.active = false;
    return 'OK';
  }

  /**
   * Get status
   * @return {string}
   */
  getStatus() {
    if (this.active === true) {
      return 'active';
    }
    return 'passive';
  }

  /**
   * Disconnect all clients for a host(name)
   * @param {string} host
   * @return {number}
   */
  disconnectClients(host = '') {
    try {
      return this._closeFrontendConnections( Array.from( this.host_headers[host].keys() ) );
    } catch (e) {
      return 0;
    }
  }

  /**
   * Disconnect all clients
   * @return {number}
   */
  disconnectAllClients() {
    try {
      return this._closeFrontendConnections( Array.from( this.sockets.keys() ) );
    } catch (e) {
      return 0;
    }
  }

}

/**
 * Export
 * ...wait for v8 to implement es6 style:
 * export default UpstreamProxy;
*/
module.exports = UpstreamProxy;
