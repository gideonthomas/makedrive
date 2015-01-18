var WebServer = require('../../server/web-server.js');
var WebSocketServer = require('ws').Server;
var env = require('../../server/lib/environment');
var uuid = require( "node-uuid" );
var expect = require('chai').expect;

var SocketServer;
var serverURL = 'http://127.0.0.1:' + env.get('PORT');
var socketURL = serverURL.replace( 'http', 'ws' );

function uniqueUsername() {
  return 'user' + uuid.v4();
}

function run(callback) {
  if(SocketServer) {
    return callback(SocketServer);
  }

  WebServer.start(function(err, server) {
    if(err) throw err;

    SocketServer = new WebSocketServer({server: server});
    callback(SocketServer);
  });
}

function decodeSocketMessage(message) {
  expect(message).to.exist;

  try {
    message = JSON.parse(message);
  } catch(err) {
    expect(err, 'Could not parse ' + message).not.to.exist;
  }

  return message;
}

module.exports = {
  serverURL: serverURL,
  socketURL: socketURL,
  username: uniqueUsername,
  run: run,
  decodeSocketMessage: decodeSocketMessage
};
