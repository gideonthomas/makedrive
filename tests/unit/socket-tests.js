var expect = require('chai').expect;
var util = require('../lib/util.js');
var SyncMessage = require('../../lib/syncmessage');
var WS = require('ws');
var syncModes = require('../../lib/constants').syncModes;
var FAKE_DATA = 'FAKE DATA';
var diffHelper = require('../../lib/diff');

function validateSocketMessage(message, expectedMessage, checkExists) {
  message = util.decodeSocketMessage(message);
  checkExists = checkExists || [];

  expect(message.type).to.equal(expectedMessage.type);
  expect(message.name).to.equal(expectedMessage.name);

  if(!expectedMessage.content) {
    expect(message.content).not.to.exist;
    return;
  }

  expect(message.content).to.exist;

  if(typeof message.content !== 'object') {
    expect(message.content).to.equal(expectedMessage.content);
    return;
  }

  Object.keys(expectedMessage.content).forEach(function(key) {
    if(checkExists.indexOf(key) !== -1) {
      expect(message.content[key]).to.exist;
    } else {
      expect(message.content[key]).to.equal(expectedMessage.content[key]);
    }
  });
}

describe('The Server', function(){
  describe('Socket protocol', function() {
    var socket, socket2;

    afterEach(function() {
      if(socket) {
        socket.close();
      }
      if(socket2) {
        socket2.close();
      }
    });

    it('should close a socket if bad data is sent in place of websocket-auth token', function(done) {
      util.run(function() {
        socket = new WS(util.socketURL);

        socket.onmessage = function() {
          expect(true).to.be.false;
        };
        socket.onopen = function() {
          socket.send('This is not a token');
        };
        socket.onclose = function(closeMessage) {
          expect(closeMessage).to.exist;
          expect(closeMessage.code).to.equal(1011);
          done();
        };
      });
    });

    it('shouldn\'t allow the same token to be used twice', function(done) {
      util.authenticatedConnection({done: done}, function(err, result) {
        expect(err).not.to.exist;

        socket = new WS(util.socketURL);
        var authMsg = {token: result.token};

        socket.onmessage = function() {
          socket2 = new WS(util.socketURL);

          socket2.onmessage = function() {
            expect(true).to.be.false;
          };
          socket2.onopen = function() {
            socket2.send(JSON.stringify(authMsg));
          };
          socket2.onclose = function(closeMessage) {
            expect(closeMessage).to.exist;
            expect(closeMessage.code).to.equal(1008);
            done();
          };
        };
        socket.onopen = function() {
          socket.send(JSON.stringify(authMsg));
        };
      });
    });

    it('should send a RESPONSE named "AUTHZ" after receiving a valid token and syncId', function(done) {
      util.authenticatedConnection({done: done}, function(err, result) {
        expect(err).not.to.exist;

        socket = new WS(util.socketURL);
        socket.onmessage = function(message) {
          validateSocketMessage(message, SyncMessage.response.authz);
          done();
        };
        socket.onopen = function() {
          socket.send(JSON.stringify({token: result.token}));
        };
      });
    });

    it('should allow two socket connections for the same username from different clients', function(done) {
      util.authenticatedConnection(function(err, result) {
        expect(err).not.to.exist;

        socket = new WS(util.socketURL);
        socket.onmessage = function() {
          util.authenticatedConnection({username: result.username}, function(err, result2) {
            expect(err).not.to.exist;
            expect(result2).to.exist;
            expect(result2.username).to.equal(result.username);
            expect(result2.token).not.to.equal(result.token);

            socket2 = new WS(util.socketURL);
            socket2.onmessage = function(message) {
              validateSocketMessage(message, SyncMessage.response.authz);
              done();
            };
            socket2.onopen = function() {
              socket2.send(JSON.stringify({token: result2.token}));
            };
          });
        };
        socket.onopen = function() {
          socket.send(JSON.stringify({token: result.token}));
        };
      });
    });

    it('should send a format SyncMessage error if a non-SyncMessage is sent', function(done) {
      util.authenticatedSocket(function(err, result, socket) {
        if(err) throw err;

        socket.onmessage = function(message) {
          var expectedMessage = SyncMessage.error.format;
          expectedMessage.content = 'Message must be formatted as a sync message';
          validateSocketMessage(message, expectedMessage);
          socket.close();
          done();
        };

        socket.send(JSON.stringify({message: 'This is not a sync message'}));
      });
    });
  });

  describe('Downstream syncs', function(){
    var authResponse = SyncMessage.response.authz.stringify();

    it('should send a "REQUEST" for "CHECKSUMS" SyncMessage to trigger a downstream when a client connects and the server has a non-empty filesystem', function(done) {
      var username = util.username();
      var file = {path: '/file', content: 'This is a file'};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            var expectedMessage = SyncMessage.request.checksums;
            expectedMessage.content = {path: file.path, type: syncModes.CREATE, sourceList: FAKE_DATA};
            validateSocketMessage(message, expectedMessage, ['sourceList']);
            done();
          };

          socket.send(authResponse);
        });
      });
    });

    it('should send a "RESPONSE" of "DIFFS" SyncMessage when requested for diffs', function(done) {
      var username = util.username();
      var file = {path: '/file', content: 'This is a file'};
      var checksums = util.generateChecksums([file]);
      var diffRequest = SyncMessage.request.diffs;
      diffRequest.content = {path: file.path, type: syncModes.CREATE, checksums: checksums[0]};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            var expectedMessage = SyncMessage.response.diffs;
            expectedMessage.content = {path: file.path, type: syncModes.CREATE, diffs: FAKE_DATA};
            validateSocketMessage(message, expectedMessage, ['diffs']);
            done();
          };

          socket.send(diffRequest.stringify());
        });
      });
    });

    it('should send a "RESPONSE" of "VERIFICATION" SyncMessage on receiving a patch response', function(done) {
      var username = util.username();
      var initializedDownstream = false;
      var file = {path: '/file', content: 'This is a file'};
      var checksums = util.generateValidationChecksums([file]);
      var patchResponse = SyncMessage.response.patch;
      patchResponse.content = {path: file.path, type: syncModes.CREATE, checksum: checksums};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            var expectedMessage = SyncMessage.response.verification;
            expectedMessage.content = {path: file.path, type: syncModes.CREATE};

            if(!initializedDownstream) {
              initializedDownstream = true;
              return socket.send(patchResponse.stringify());
            }

            validateSocketMessage(message, expectedMessage);
            done();
          };

          socket.send(authResponse);
        });
      });
    });

    it('should allow an upstream sync request for a file if that file has been downstreamed', function(done) {
      var username = util.username();
      var file = {path: '/file', content: 'This is a file'};
      var currentStep = 'AUTH';
      var checksums = util.generateValidationChecksums([file]);
      var patchResponse = SyncMessage.response.patch;
      patchResponse.content = {path: file.path, type: syncModes.CREATE, checksum: checksums};
      var syncRequest = SyncMessage.request.sync;
      syncRequest.content = {path: file.path, type: syncModes.CREATE};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            if(currentStep === 'AUTH') {
              currentStep = 'PATCH';
              socket.send(patchResponse.stringify());
            } else if(currentStep === 'PATCH') {
              currentStep = null;
              socket.send(syncRequest.stringify());
            } else {
              var expectedMessage = SyncMessage.response.sync;
              expectedMessage.content = {path: file.path, type: syncModes.CREATE};
              validateSocketMessage(message, expectedMessage);
              done();
            }
          };

          socket.send(authResponse);
        });
      });
    });

    it('should handle root responses from the client by removing the file from the downstream queue for that client', function(done) {
      // Since we do not have access to the internals of the server,
      // we test this case by sending a root response to the server
      // and requesting an upstream sync for the same file, which
      // should succeed.
      var username = util.username();
      var file = {path: '/file', content: 'This is a file'};
      var rootMessage = SyncMessage.response.root;
      rootMessage.content = {path: file.path, type: syncModes.CREATE};
      var syncRequest = SyncMessage.request.sync;
      syncRequest.content = {path: file.path, type: syncModes.CREATE};
      var rootMessageSent = false;

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            if(!rootMessageSent) {
              // NOTE: Under normal circumstances, a sync request
              // message would not be sent to the server, however
              // since that is the only way to test server internals
              // (indirectly), this has an important implication.
              // This test may fail as two socket messages are sent
              // one after the other and an ASSUMPTION has been made
              // that the first socket message executes completely
              // before the second socket message executes. If this
              // test fails, the most likely cause would be the below
              // three lines of code that introduces a timing issue.
              socket.send(rootMessage.stringify());
              rootMessageSent = true;
              return socket.send(syncRequest.stringify());
            }

            var expectedMessage = SyncMessage.response.sync;
            expectedMessage.content = {path: file.path, type: syncModes.CREATE};
            validateSocketMessage(message, expectedMessage);
            done();
          };

          socket.send(authResponse);
        });
      });
    });

    it('should send a "DOWNSTREAM_LOCKED" "ERROR" if a "REQUEST" for "DIFFS" is sent while an upstream sync is triggered for the same file by another client', function(done) {
      var username = util.username();
      var file = {path: '/file', content: 'This is a file'};
      var checksums = util.generateChecksums([file]);
      var diffRequest = SyncMessage.request.diffs;
      diffRequest.content = {path: file.path, type: syncModes.CREATE, checksums: checksums[0]};
      var authorized = false;
      var syncRequest = SyncMessage.request.sync;
      syncRequest.content = {path: file.path, type: syncModes.CREATE};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          util.authenticatedSocket({username: username}, function(err, result, socket2) {
            if(err) throw err;

            socket.onmessage = function(message) {
              if(!authorized) {
                authorized = true;
                return socket2.send(syncRequest.stringify());
              }

              var expectedMessage = SyncMessage.error.downstreamLocked;
              expectedMessage.content = {path: file.path, type: syncModes.CREATE};
              validateSocketMessage(message, expectedMessage);
              done();
            };

            socket2.onmessage = function() {
              socket.send(diffRequest.stringify());
            };

            socket.send(authResponse);
          });
        });
      });
    });

    it('should send a "VERIFICATION" "ERROR" SyncMessage on receiving a patch response that incorrectly patched a file on the client', function(done) {
      var username = util.username();
      var initializedDownstream = false;
      var file = {path: '/file', content: 'This is a file'};
      var patchResponse = SyncMessage.response.patch;
      patchResponse.content = {path: file.path, type: syncModes.CREATE};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        file.content = 'Modified content';
        patchResponse.content.checksum = util.generateValidationChecksums([file]);

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            var expectedMessage = SyncMessage.error.verification;
            expectedMessage.content = {path: file.path, type: syncModes.CREATE};

            if(!initializedDownstream) {
              initializedDownstream = true;
              return socket.send(patchResponse.stringify());
            }

            validateSocketMessage(message, expectedMessage);
            done();
          };

          socket.send(authResponse);
        });
      });
    });
  });

  describe('Upstream syncs', function() {
    var file = {path: '/file', content: 'This is a file'};

    it('should send a "RESPONSE" of "SYNC" if a sync is requested on a file without a lock', function(done) {
      var syncRequest = SyncMessage.request.sync;
      syncRequest.content = {path: file.path, type: syncModes.CREATE};

      util.authenticatedSocket(function(err, result, socket) {
        if(err) throw err;

        socket.onmessage = function(message) {
          var expectedMessage = SyncMessage.response.sync;
          expectedMessage.content = {path: file.path, type: syncModes.CREATE};

          validateSocketMessage(message, expectedMessage);
          done();
        };

        socket.send(syncRequest.stringify());
      });
    });

    it('should send a "LOCKED" "ERROR" if a sync is requested on a file that is locked', function(done) {
      var syncRequest = SyncMessage.request.sync;
      syncRequest.content = {path: file.path, type: syncModes.CREATE};

      util.authenticatedSocket(function(err, result, socket) {
        if(err) throw err;

        util.authenticatedSocket({username: result.username}, function(err, result, socket2) {
          if(err) throw err;

          socket.onmessage = function() {
            socket2.send(syncRequest.stringify());
          };

          socket2.onmessage = function(message) {
            var expectedMessage = SyncMessage.error.locked;
            expectedMessage.content = {error: 'Sync already in progress', path: file.path, type: syncModes.CREATE};

            validateSocketMessage(message, expectedMessage);
            done();
          };

          socket.send(syncRequest.stringify());
        });
      });
    });

    it('should send a "REQUEST" for "DIFFS" containing checksums when requested for checksums', function(done) {
      var syncRequested = false;
      var syncRequest = SyncMessage.request.sync;
      syncRequest.content = {path: file.path, type: syncModes.CREATE};
      var checksumRequest = SyncMessage.request.checksums;
      checksumRequest.content = {path: file.path, type: syncModes.CREATE, sourceList: util.generateSourceList([file])};

      util.authenticatedSocket(function(err, result, socket) {
        if(err) throw err;

        socket.onmessage = function(message) {
          var expectedMessage = SyncMessage.request.diffs;
          expectedMessage.content = {path: file.path, type: syncModes.CREATE, checksums: FAKE_DATA};

          if(!syncRequested) {
            syncRequested = true;
            return socket.send(checksumRequest.stringify());
          }

          validateSocketMessage(message, expectedMessage, ['checksums']);
          done();
        };

        socket.send(syncRequest.stringify());
      });
    });

    it('should patch the file being synced and send a "RESPONSE" of "PATCH" on receiving a diff response', function(done) {
      var syncRequested = false;
      var syncRequest = SyncMessage.request.sync;
      syncRequest.content = {path: file.path, type: syncModes.CREATE};
      var diffResponse = SyncMessage.response.diffs;
      diffResponse.content = {path: file.path, type: syncModes.CREATE, diffs: diffHelper.serialize(util.generateDiffs([file]))};
      var layout = {};
      layout[file.path] = file.content;

      util.authenticatedSocket(function(err, result, socket) {
        if(err) throw err;

        socket.onmessage = function(message) {
          var expectedMessage = SyncMessage.response.patch;
          expectedMessage.content = {path: file.path, type: syncModes.CREATE};

          if(!syncRequested) {
            syncRequested = true;
            return socket.send(diffResponse.stringify());
          }

          validateSocketMessage(message, expectedMessage);
          util.ensureRemoteFilesystem(layout, result.jar, function(err) {
            expect(err).not.to.exist;
            done();
          });
        };

        socket.send(syncRequest.stringify());
      });
    });

  //   it('should block a downstream sync diffs request from the client after an upstream sync has been started', function(done) {
  //     // First client connects
  //     util.authenticatedConnection({done: done}, function(err, result1) {
  //       expect(err).not.to.exist;

  //       // Second client connects
  //       util.authenticatedConnection({username: result1.username}, function(err, result2) {
  //         expect(err).not.to.exist;

  //         // First client completes the initial downstream sync
  //         util.prepareUpstreamSync(result1.username, result1.token, function(err, data1, fs1, socketPackage1){
  //           expect(err).not.to.exist;

  //           // First client completes the first step of a downstream sync
  //           util.downstreamSyncSteps.requestSync(socketPackage1, data1, fs1, function(err, downstreamData) {
  //             expect(err).to.not.exist;

  //             // Second client begins an upstream sync
  //             util.prepareUpstreamSync('requestSync', result1.username, result2.token, function(data2, fs2, socketPackage2) {
  //               // First client attempts the second step of an downstream sync, expecting an error
  //               util.downstreamSyncSteps.generateDiffs(socketPackage1, downstreamData, fs1, function(msg, cb) {
  //                 msg = util.toSyncMessage(msg);

  //                 expect(msg).to.exist;
  //                 expect(msg.type).to.equal(SyncMessage.ERROR);
  //                 expect(msg.name).to.equal(SyncMessage.DOWNSTREAM_LOCKED);

  //                 cb();
  //               }, function() {
  //                 util.cleanupSockets(function(){
  //                   result1.done();
  //                   result2.done();
  //                 }, socketPackage1, socketPackage2);
  //               });
  //             });
  //           });
  //         });
  //       });
  //     });
  //   });

  //   it('should allow the patch verification from the client after an upstream sync has been started', function(done) {
  //     // First client connects
  //     util.authenticatedConnection({done: done}, function(err, result1) {
  //       expect(err).not.to.exist;

  //       // Second client connects
  //       util.authenticatedConnection({username: result1.username}, function(err, result2) {
  //         expect(err).not.to.exist;

  //         // First client completes the initial downstream sync
  //         util.prepareUpstreamSync(result1.username, result1.token, function(err, data1, fs1, socketPackage1){
  //           expect(err).not.to.exist;

  //           // First client completes the first step of a downstream sync
  //           util.downstreamSyncSteps.requestSync(socketPackage1, data1, fs1, function(err, downstreamData) {
  //             expect(err).to.not.exist;

  //             // First client completes the second step of a downstream sync
  //             util.downstreamSyncSteps.generateDiffs(socketPackage1, downstreamData, fs1, function(err, downstreamData2) {
  //               expect(err).to.not.exist;

  //               // Second client begins an upstream sync
  //               util.prepareUpstreamSync('requestSync', result1.username, result2.token, function(data2, fs2, socketPackage2) {

  //                 // First client attempts the final step of an downstream sync, expect all to be well.
  //                 util.downstreamSyncSteps.patchClientFilesystem(socketPackage1, downstreamData2, fs1, function(err) {
  //                   expect(err).to.not.exist;

  //                   util.cleanupSockets(function(){
  //                     result1.done();
  //                     result2.done();
  //                   }, socketPackage1, socketPackage2);
  //                 });
  //               });
  //             });
  //           });
  //         });
  //       });
  //     });
  //   });
  });

  // describe('Generate Diffs', function() {
  //   it('should return an RESPONSE message with the diffs', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync(result.username, result.token, function(err, syncData, fs, socketPackage) {
  //         util.downstreamSyncSteps.generateDiffs(socketPackage, syncData, fs, function(msg, cb) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg.type, "[Message type error: \"" + (msg.content && msg.content.error) +"\"]" ).to.equal(SyncMessage.RESPONSE);
  //           expect(msg.name).to.equal(SyncMessage.DIFFS);
  //           expect(msg.content).to.exist;
  //           expect(msg.content.diffs).to.exist;
  //           cb();
  //         }, function() {
  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });

  //   it('should return an ERROR type message named DIFFS when faulty checksums are sent', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync(result.username, result.token, function(err, syncData, fs, socketPackage) {
  //         var diffRequest = SyncMessage.request.diffs;
  //         diffRequest.content = {
  //           checksums: "jargon"
  //         };
  //         util.sendSyncMessage(socketPackage, diffRequest, function(msg) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg.type, "[Message type error: \"" + (msg.content && msg.content.error) +"\"]" ).to.equal(SyncMessage.ERROR);
  //           expect(msg.name).to.equal(SyncMessage.DIFFS);
  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });

  //   it('should return an SyncMessage with error content when no checksums are sent', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync(result.username, result.token, function(err, syncData, fs, socketPackage) {
  //         var diffRequest = SyncMessage.request.diffs;
  //         util.sendSyncMessage(socketPackage, diffRequest, function(msg) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg).to.eql(SyncMessage.error.content);
  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });
  // });

  // describe('Patch the client filesystem', function() {
  //   it('should make the server respond with a RESPONSE SYNC SyncMessage after ending a downstream sync, and initiating an upstream sync', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync('generateDiffs', result.username, result.token, function(err, syncData, fs, socketPackage) {
  //         util.downstreamSyncSteps.patchClientFilesystem(socketPackage, syncData, fs, function(msg, cb) {
  //           msg = util.toSyncMessage(msg);
  //           var startSyncMsg = SyncMessage.request.sync;
  //           startSyncMsg.content = {path: '/'};
  //           util.sendSyncMessage(socketPackage, startSyncMsg, function(message){
  //             message = util.toSyncMessage(message);

  //             expect(message).to.exist;
  //             expect(message.type).to.equal(SyncMessage.RESPONSE);
  //             expect(message.name).to.equal(SyncMessage.SYNC);

  //             cb();
  //           });
  //         }, function() {
  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });

  //   it('should return an IMPLEMENTATION ERROR SyncMessage when sent out of turn', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync(result.username, result.token, function(err, data, fs, socketPackage) {
  //         var startSyncMsg = SyncMessage.request.sync;
  //         startSyncMsg.content = {path: '/'};
  //         util.sendSyncMessage(socketPackage, startSyncMsg, function(msg){
  //           msg = util.toSyncMessage(msg);

  //           expect(msg).to.exist;
  //           expect(msg.type).to.equal(SyncMessage.ERROR);
  //           expect(msg.name).to.equal(SyncMessage.IMPL);
  //           expect(msg.content).to.exist;
  //           expect(msg.content.error).to.exist;

  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });
  // });

  // describe('Request checksums', function() {
  //   it('should return a CONTENT error SyncMessage if srcList isn\'t passed', function(done) {
  //     // Authorize a user, open a socket, authorize and complete a downstream sync
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareUpstreamSync('requestSync', result.username, result.token, function(syncData, fs, socketPackage) {
  //         var requestChksumMsg = SyncMessage.request.chksum;
  //         requestChksumMsg.content = {
  //           path: syncData.path
  //         };
  //         socketPackage.socket.send(requestChksumMsg.stringify());

  //         util.sendSyncMessage(socketPackage, requestChksumMsg, function(msg) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg).to.deep.equal(SyncMessage.error.content);

  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });
  //   it('should return a CONTENT error SyncMessage if no data is passed', function(done) {
  //     // Authorize a user, open a socket, authorize and complete a downstream sync
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareUpstreamSync('requestSync', result.username, result.token, function(syncData, fs, socketPackage) {
  //         var requestChksumMsg = SyncMessage.request.chksum;
  //         requestChksumMsg.content = {};
  //         socketPackage.socket.send(requestChksumMsg.stringify());

  //         util.sendSyncMessage(socketPackage, requestChksumMsg, function(msg) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg).to.deep.equal(SyncMessage.error.content);

  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });
  // });
});
