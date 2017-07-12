const net = require('net');
const http = require('http');
const events = require('events');
const HTTPParserModule = process.binding('http_parser');
const HTTPParser = HTTPParserModule.HTTPParser;

class HttpMessageParser extends events.EventEmitter {
  constructor(type) {
    super();
    const parser = new HTTPParser(type == 'request' ? HTTPParser.REQUEST : HTTPParser.RESPONSE);
    const kOnHeaders = HTTPParser.kOnHeaders | 0;
    const kOnHeadersComplete = HTTPParser.kOnHeadersComplete | 0;
    const kOnBody = HTTPParser.kOnBody | 0;
    const kOnMessageComplete = HTTPParser.kOnMessageComplete | 0;
    const kOnExecute = HTTPParser.kOnExecute | 0;
    var message;
    parser.maxHeaderPairs = 2000;
    parser[kOnHeadersComplete] = (versionMajor, versionMinor, headers, method,
      url, statusCode, statusMessage, upgrade, shouldKeepAlive) => {
      message = {headers: {}}
      for (var i in headers) {
        if (i % 2 == 1) {
          message.headers[headers[i - 1].toLowerCase()] = headers[i];
        }
      }
      message.url = url;
      message.versionMajor = versionMajor;
      message.versionMinor = versionMinor;
      message.method = method ? HTTPParserModule.methods[method] : null;
      message.url = url;
      message.statusCode = statusCode;
      message.statusMessage = statusMessage;
      message.upgrade = upgrade;
      message.shouldKeepAlive = shouldKeepAlive;
      this.emit('headers', message);
    }
    parser[kOnBody] = (chunk, offset, length) => {
      this.emit('body', chunk, offset, length);
    }
    this.parser = parser;
  }

  execute(buffer, offset, length) {
    return this.parser.execute(buffer, offset, length);
  }
}

module.exports = HttpMessageParser;
