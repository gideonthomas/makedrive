var SyncMessage = require('../../lib/syncmessage');
var rsync = require('../../lib/rsync');
var rsyncUtils = rsync.utils;
var rsyncOptions = require('../../lib/constants').rsyncDefaults;
var serializeDiff = require('../../lib/diff').serialize;
var deserializeDiff = require('../../lib/diff').deserialize;
var states = require('./sync-states');
var steps = require('./sync-steps');
var async = require('../../lib/async-lite');
var fsUtils = require('../../lib/fs-utils');
var log = require('./logger.js');

function onError(syncManager, err) {
  syncManager.session.step = steps.FAILED;
  syncManager.sync.onError(err);
}

function sendChecksums(syncManager, path, sourceList) {
  var fs = syncManager.fs;
  var rawFs = syncManager.rawFs;
  var sync = syncManager.sync;
  var message;

  // If the server requests to downstream a path that is not in the
  // root, ignore the downstream.
  if(path.indexOf(fs.root) !== 0) {
    message = SyncMessage.response.root;
    message.content = {path: path};
    log.info('Ignoring downstream sync for ' + path);
    return syncManager.send(message.stringify());
  }

  syncManager.downstreams.push(path);
  sync.onSyncing(path);

  rsync.checksums(rawFs, path, sourceList, rsyncOptions, function(err, checksums) {
    if(err) {
      log.error('Failed to generate checksums for ' + path + ' during downstream sync', err);
      message = SyncMessage.request.delay;
      message.content = {path: path};
      syncManager.send(message.stringify());
      return onError(syncManager, err);
    }

    fs.record(path, sourceList);
    message = SyncMessage.request.diffs;
    message.content = {path: path, checksums: checksums};
    syncManager.send(message.stringify());
  });
}

function handleRequest(syncManager, data) {
  var fs = syncManager.fs;
  var rawFs = syncManager.rawFs;

  function handleChecksumRequest() {
    if(data.invalidContent(['sourceList'])) {
      log.error('Path or source list not sent by server in handleChecksumRequest.', data);
      return onError(syncManager, new Error('Server sent insufficient content'));
    }

    sendChecksums(data.content.path, data.content.sourceList);
  }

  function handleDiffRequest() {
    if(data.invalidContent(['type', 'checksums'])) {
      log.warn(data, 'Upstream sync message received from the server without sufficient information in handleDiffRequest');
      return fs.delaySync(function(err, path) {
        if(err) {
          log.error(err, 'An error occured while updating paths to sync in handleDiffRequest');
          return onError(syncManager, err);
        }

        log.info('Sync delayed for ' + path + ' in handleDiffRequest');
        syncManager.currentSync = false;
        syncManager.syncUpstream();
      });
    }

    var path = data.content.path;
    var type = data.content.type;
    var checksums = data.content.checksums;

    rsync.diff(rawFs, path, checksums, rsyncOptions, function(err, diffs) {
      if(err){
        log.error(err, 'Error generating diffs in handleDiffRequest for ' + path);
        return fs.delaySync(function(delayErr, delayedPath) {
          if(delayErr) {
            log.error(err, 'Error updating paths to sync in handleDiffRequest after failing to generate diffs for ' + path);
            return onError(syncManager, delayErr);
          }

          log.info('Sync delayed for ' + delayedPath + ' in handleDiffRequest');
          syncManager.currentSync = false;
          syncManager.syncUpstream();
        });
      }

      var message = SyncMessage.response.diffs;
      message.content = {path: path, type: type, diffs: serializeDiff(diffs)};
      syncManager.send(message.stringify());
    });
  }


  if(data.is.checksums) {
    // DOWNSTREAM - CHKSUM
    handleChecksumRequest();
  } else if(data.is.diffs) {
    // UPSTREAM - DIFFS
    handleDiffRequest();
  } else {
    onError(syncManager, new Error('Failed to sync with the server.'));
  }
}

function handleResponse(syncManager, data) {
  var fs = syncManager.fs;
  var rawFs = syncManager.rawFs;
  var sync = syncManager.sync;

  function handleSourceListResponse() {
    if(data.invalidContent(['type'])) {
      log.warn(data, 'Upstream sync message received from the server without sufficient information in handleSourceListResponse');
      return fs.delaySync(function(err, path) {
        if(err) {
          log.error(err, 'An error occured while updating paths to sync in handleSourceListResponse');
          return onError(syncManager, err);
        }

        log.info('Sync delayed for ' + path + ' in handleSourceListResponse');
        syncManager.currentSync = false;
        syncManager.syncUpstream();
      });
    }

    var path = data.content.path;

    sync.onSyncing(path);

    rsync.sourceList(rawFs, path, rsyncOptions, function(err, sourceList) {
      if(err){
        log.error(err, 'Error generating source list in handleSourceListResponse for ' + path);
        return fs.delaySync(function(delayErr, delayedPath) {
          if(delayErr) {
            log.error(err, 'Error updating paths to sync in handleSourceListResponse after failing to generate source list for ' + path);
            return onError(syncManager, delayErr);
          }

          log.info('Sync delayed for ' + delayedPath + ' in handleSourceListResponse');
          syncManager.currentSync = false;
          syncManager.syncUpstream();
        });
      }

      var message = SyncMessage.request.checksum;
      message.content = {path: path, type: data.content.type, sourceList: sourceList};
      syncManager.send(message.stringify());
    });
  }

  // As soon as an upstream sync happens, the file synced
  // becomes the last synced version and must be stamped
  // with its checksum to version it
  function handlePatchAckResponse() {
    var syncedPath = data.content.path;

    function complete() {
      fs.dequeueSync(function(err, syncsLeft, dequeuedSync) {
        if(err) {
          log.error('Failed to dequeue sync for ' + syncedPath + ' in handlePatchAckResponse, complete()');
        }

        sync.onCompleted(dequeuedSync || syncedPath);
      });
    }

    fs.lstat(syncedPath, function(err, stats) {
      if(err) {
        if(err.code !== 'ENOENT') {
          log.error('Failed to access ' + syncedPath + ' in handlePatchAckResponse');
          return fs.delaySync(function(delayErr, delayedPath) {
            if(delayErr) {
              log.error('Failed to delay upstream sync for ' + delayedPath + ' in handlePatchAckResponse');
            }
            onError(syncManager, err);
          });
        }

        // Non-existent paths (usually due to renames or
        // deletes cannot be stamped with a checksum
        return complete();
      }

      if(!stats.isFile()) {
        return complete();
      }

      rsyncUtils.getChecksum(rawFs, syncedPath, function(err, checksum) {
        if(err) {
          log.error('Failed to get the checksum for ' + syncedPath + ' in handlePatchAckResponse');
          return fs.delaySync(function(delayErr, delayedPath) {
            if(delayErr) {
              log.error('Failed to delay upstream sync for ' + delayedPath + ' in handlePatchAckResponse while getting checksum');
            }
            onError(syncManager, err);
          });
        }

        fsUtils.setChecksum(rawFs, syncedPath, checksum, function(err) {
          if(err) {
            log.error('Failed to stamp the checksum for ' + syncedPath + ' in handlePatchAckResponse');
            return fs.delaySync(function(delayErr, delayedPath) {
              if(delayErr) {
                log.error('Failed to delay upstream sync for ' + delayedPath + ' in handlePatchAckResponse while setting checksum');
              }
              onError(syncManager, err);
            });
          }

          complete();
        });
      });
    });
  }

  function handlePatchResponse() {
    var message;

    if(data.invalidContent(['diffs'])) {
      log.error('Path or diffs not sent by server in handlePatchResponse.', data);
      return onError(syncManager, new Error('Server sent insufficient content'));
    }

    var path = data.content.path;
    var diffs = deserializeDiff(data.content.diffs);
    var changedDuringDownstream = fs.changesDuringDownstream.indexOf(path);
    var cachedSourceList = fs.stopRecording(path);

    if(changedDuringDownstream !== -1) {
      // Resend the checksums for that path
      return sendChecksums(syncManager, path, cachedSourceList);
    }

    rsync.patch(rawFs, path, diffs, rsyncOptions, function(err, paths) {
      if(err) {
        log.error('Failed to patch ' + path + ' during downstream sync', err);
        message = SyncMessage.request.delay;
        message.content = {path: path};
        syncManager.send(message.stringify());
        return onError(syncManager, err);
      }

      syncManager.needsUpstream = syncManager.needsUpstream ? syncManager.needsUpstream.concat(paths.needsUpstream) : paths.needsUpstream;

      rsyncUtils.generateChecksums(fs, paths.synced, true, function(err, checksums) {
        if(err) {
          log.error('Failed to generate checksums for ' + paths.synced + ' during downstream patch', err);
          message = SyncMessage.request.delay;
          message.content = {path: path};
          syncManager.send(message.stringify());
          return onError(syncManager, err);
        }

        message = SyncMessage.response.patch;
        message.content = {path: path, checksums: checksums};
        syncManager.send(message.stringify());
      });
    });
  }

  function handleVerificationResponse() {
    var path = data.content.path;
    syncManager.downstreams.splice(syncManager.downstreams.indexOf(path));
    sync.onCompleted(path, syncManager.needsUpstream);
  }

  if(data.is.sync) {
    // UPSTREAM - INIT
    handleSourceListResponse();
  } else if(data.is.patch) {
    // UPSTREAM - PATCH
    handlePatchAckResponse();
  } else if(data.is.diffs) {
    // DOWNSTREAM - PATCH
    handlePatchResponse();
  } else if(data.is.verification) {
    // DOWNSTREAM - PATCH VERIFICATION
    handleVerificationResponse();
  }  else {
    onError(syncManager, new Error('Failed to sync with the server.'));
  }
}

function handleError(syncManager, data) {
  var sync = syncManager.sync;
  var session = syncManager.session;
  var message = SyncMessage.response.reset;

  // DOWNSTREAM - ERROR
  if((((data.is.sourceList && session.is.synced)) ||
      (data.is.diffs && session.is.patch) && (session.is.ready || session.is.syncing))) {
    session.state = states.READY;
    session.step = steps.SYNCED;

    syncManager.send(message.stringify());
    onError(syncManager, new Error('Could not sync filesystem from server... trying again'));
  } else if(data.is.verification && session.is.patch && session.is.ready) {
    syncManager.send(message.stringify());
    onError(syncManager, new Error('Could not sync filesystem from server... trying again'));
  } else if(data.is.locked && session.is.ready && session.is.synced) {
    // UPSTREAM - LOCK
    onError(syncManager, new Error('Current sync in progress! Try again later!'));
  } else if(((data.is.chksum && session.is.diffs) ||
             (data.is.patch && session.is.patch)) &&
            session.is.syncing) {
    // UPSTREAM - ERROR
    var message = SyncMessage.request.reset;
    syncManager.send(message.stringify());
    onError(syncManager, new Error('Could not sync filesystem from server... trying again'));
  } else if(data.is.maxsizeExceeded) {
    // We are only emitting the error since this is can be sync again from the client
    syncManager.sync.emit('error', new Error('Maximum file size exceeded'));
  } else if(data.is.interrupted && session.is.syncing) {
    // SERVER INTERRUPTED SYNC (LOCK RELEASED EARLY)
    sync.onInterrupted();
  } else {
    onError(syncManager, new Error('Failed to sync with the server. Current step is: ' +
                                    session.step + '. Current state is: ' + session.state));
  }
}

function handleMessage(syncManager, data) {
  try {
    data = JSON.parse(data);
    data = SyncMessage.parse(data);
  } catch(e) {
    return onError(syncManager, e);
  }

  if (data.is.request) {
    handleRequest(syncManager, data);
  } else if(data.is.response){
    handleResponse(syncManager, data);
  } else if(data.is.error){
    handleError(syncManager, data);
  } else {
    onError(syncManager, new Error('Cannot handle message'));
  }
}

module.exports = handleMessage;
