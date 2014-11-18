/**
 * An extended Filer FileSystem with wrapped methods
 * for writing that manage file metadata (xattribs)
 * reflecting sync state.
 */

var Filer = require('../../lib/filer.js');
var Shell = require('../../lib/filer-shell.js');
var fsUtils = require('../../lib/fs-utils.js');
var conflict = require('../../lib/conflict.js');
var syncModes = require('../../lib/constants.js').syncModes;

function SyncFileSystem(fs) {
  var self = this;
  var root = '/';
  // Record changes during a downstream sync
  var recordChanges = false;
  var changesDuringDownstream = [];

  // Expose the root used to sync for the filesystem
  // Defaults to '/'
  Object.defineProperties(self, {
    'root': {
      get: function() { return root; }
    },
    'record': {
      set: function(value) {
        recordChanges = value;

        if(!value) {
          changesDuringDownstream = [];
        }
      }
    },
    'changesDuringDownstream': {
      get: function() { return changesDuringDownstream; }
    }
  });

  self.removeFromDownstreamTracking = function(path) {
    changesDuringDownstream.splice(changesDuringDownstream.indexOf(path), 1);
  };

  // Get the paths queued up to sync
  self.getPathsToSync = function(callback) {
    fsUtils.getPathsToSync(fs, root, function(err, pathsToSync) {
      if(err) {
        return callback(err);
      }

      callback(null, pathsToSync && pathsToSync.toSync);
    });
  };

  // Add paths to the sync queue where paths is an array
  self.appendPathsToSync = function(paths, callback) {
    paths = paths.filter(function(path) {
      return !!(path.indexOf(root) === 0);
    });

    fsUtils.getPathsToSync(fs, root, function(err, pathsToSync) {
      if(err) {
        return callback(err);
      }

      pathsToSync.toSync = pathsToSync.toSync.concat(paths);

      fsUtils.setPathsToSync(fs, root, pathsToSync, callback);
    });
  };

  // Get the path that was modified during a sync
  self.getModifiedPath = function(callback) {
    fsUtils.getPathsToSync(fs, root, function(err, pathsToSync) {
      if(err) {
        return callback(err);
      }

      callback(null, pathsToSync && pathsToSync.modified);
    });
  };

  // Indicate that the path on top of the queue has
  // begun syncing
  self.setSyncing = function(callback) {
    fsUtils.getPathsToSync(fs, root, function(err, pathsToSync) {
      if(err) {
        return callback(err);
      }

      if(!pathsToSync || !pathsToSync.toSync || !pathsToSync.toSync[0]) {
        return callback();
      }

      pathsToSync.toSync[0].syncing = true;

      callback();
    });
  };

  // Delay the sync of the currently syncing path
  // by moving it to the end of the sync queue
  self.delaySync = function(callback) {
    fsUtils.getPathsToSync(fs, root, function(err, pathsToSync) {
      if(err) {
        return callback(err);
      }

      if(!pathsToSync || !pathsToSync.toSync || !pathsToSync.toSync[0]) {
        return callback();
      }

      var delayedPath = pathsToSync.toSync.shift();
      pathsToSync.toSync.push(delayedPath);
      delete pathsToSync.modified;

      fsUtils.setPathsToSync(fs, root, pathsToSync, function(err) {
        if(err) {
          return callback(err);
        }

        callback(null, delayedPath);
      });
    });
  };

  // Remove the path that was just synced
  self.dequeueSync = function(callback) {
    fsUtils.getPathsToSync(fs, root, function(err, pathsToSync) {
      if(err) {
        return callback(err);
      }

      if(!pathsToSync || !pathsToSync.toSync || !pathsToSync.toSync[0]) {
        return callback();
      }

      var removedPath = pathsToSync.toSync.shift();
      if(!pathsToSync.toSync.length) {
        delete pathsToSync.toSync;
      }
      delete pathsToSync.modified;

      fsUtils.setPathsToSync(fs, root, pathsToSync, function(err) {
        if(err) {
          return callback(err);
        }

        callback(null, removedPath);
      });
    });
  };

  // Set the sync root for the filesystem.
  // The path provided must name an existing directory
  // or the setter will fail.
  // Once the new root is set, the paths remaining to
  // sync and the path that was modified during a sync
  // are filtered out if they are not under the new root.
  self.setRoot = function(newRoot, callback) {
    function containsRoot(pathOrObj) {
      var path = pathOrObj;
      if(typeof pathOrObj === 'object') {
        path = pathOrObj.path || '';
      }

      return !!(path.indexOf(newRoot) === 0);
    }

    fs.lstat(newRoot, function(err, stats) {
      if(err) {
        return callback(err);
      }

      if(!stats.isDirectory()) {
        return callback(new Filer.Errors.ENOTDIR('the given root is not a directory', newRoot));
      }

      fsUtils.getPathsToSync(fs, root, function(err, pathsToSync) {
        if(err) {
          return callback(err);
        }

        root = newRoot;

        if(!pathsToSync) {
          return callback();
        }

        if(pathsToSync.toSync) {
          pathsToSync.toSync = pathsToSync.toSync.filter(containsRoot);

          if(!pathsToSync.toSync.length) {
            delete pathsToSync.toSync;
          }
        }

        if(pathsToSync.modified && !containsRoot(pathsToSync.modified)) {
          delete pathsToSync.modified;
        }

        callback();
      });
    });
  };

  // The following non-modifying fs operations can be run as normal,
  // and are simply forwarded to the fs instance. NOTE: we have
  // included setting xattributes since we don't sync these to the server (yet).
  ['stat', 'fstat', 'lstat', 'exists', 'readlink', 'realpath',
   'readdir', 'open', 'close', 'fsync', 'read', 'readFile',
   'setxattr', 'fsetxattr', 'getxattr', 'fgetxattr', 'removexattr',
   'fremovexattr', 'watch'].forEach(function(method) {
     self[method] = function() {
       fs[method].apply(fs, arguments);
     };
  });

  function fsetUnsynced(fd, callback) {
    fsUtils.fsetUnsynced(fs, fd, callback);
  }

  function setUnsynced(path, callback) {
    fsUtils.setUnsynced(fs, path, callback);
  }

  // We wrap all fs methods that modify the filesystem in some way that matters
  // for syncing (i.e., changes we need to sync back to the server), such that we
  // can track things. Different fs methods need to do this in slighly different ways,
  // but the overall logic is the same.  The wrapMethod() fn defines this logic.
  function wrapMethod(method, pathArgPos, setUnsyncedFn, mode) {
    return function() {
      var args = Array.prototype.slice.call(arguments, 0);
      var lastIdx = args.length - 1;
      var callback = args[lastIdx];

      // Grab the path or fd so we can use it to set the xattribute.
      // Most methods take `path` or `fd` as the first arg, but it's
      // second for some.
      var pathOrFD = args[pathArgPos];

      function wrappedCallback() {
        var args = Array.prototype.slice.call(arguments, 0);
        if(args[0]) {
          return callback(args[0]);
        }

        setUnsyncedFn(pathOrFD, function(err) {
          if(err) {
            return callback(err);
          }
          callback.apply(null, args);
        });
      }

      args[lastIdx] = wrappedCallback;

      if(mode === syncModes.DELETE && pathOrFD === root) {
        // Deal with deletion of the sync root
        // https://github.com/mozilla/makedrive/issues/465
      }

      // Don't record extra sync-level details about modifications to an
      // existing conflicted copy, since we don't sync them.
      conflict.isConflictedCopy(fs, pathOrFD, function(err, conflicted) {
        // Deal with errors other than the path not existing (this fs
        // call might be creating it, in which case it's also not conflicted).
        if(err && err.code !== 'ENOENT') {
          return callback.apply(null, [err]);
        }

        conflicted = !!conflicted;

        // Check to see if it is a path or an open file descriptor
        // and do not record the path if it is not contained
        // in the specified syncing root of the filesystem, or if it is conflicted.
        // TODO: Deal with a case of fs.open for a path with a write flag
        // https://github.com/mozilla/makedrive/issues/210.
        if(fs.openFiles[pathOrFD] || pathOrFD.indexOf(root) !== 0 || conflicted) {
          fs[method].apply(fs, args);
          return;
        }

        if(recordChanges && self.changesDuringDownstream.indexOf(pathOrFD) === -1) {
          self.changedDuringDownstream.push(pathOrFD);
        }

        // Queue the path for syncing in the pathsToSync
        // xattr on the sync root
        fsUtils.getPathsToSync(fs, root, function(err, pathsToSync) {
          var syncPath = {
            path: pathOrFD,
            type: mode
          };
          var indexInPathsToSync;

          if(err) {
            return callback(err);
          }

          pathsToSync = pathsToSync || {};
          pathsToSync.toSync = pathsToSync.toSync || [];
          indexInPathsToSync = pathsToSync.indexOf(pathOrFD);

          if(indexInPathsToSync === 0) {
            // If at the top of pathsToSync, the path is
            // currently syncing so change the modified path
            pathsToSync.modified = pathOrFD;
          } else if(indexInPathsToSync === -1) {
            pathsToSync.toSync.push(syncPath);
          }

          fsUtils.setPathsToSync(fs, root, pathsToSync, function(err) {
            if(err) {
              return callback(err);
            }

            fs[method].apply(fs, args);
          });
        });
      });
    };
  }

  // Wrapped fs methods that have path at first arg position and use paths
  ['truncate', 'mknod', 'mkdir', 'utimes', 'writeFile',
   'appendFile'].forEach(function(method) {
     self[method] = wrapMethod(method, 0, setUnsynced, syncModes.CREATE);
  });

  // Wrapped fs methods that have path at second arg position
  ['link', 'symlink'].forEach(function(method) {
    self[method] = wrapMethod(method, 1, setUnsynced, syncModes.CREATE);
  });

  // Wrapped fs methods that have path at second arg position, and need to use the parent path.
  ['rename'].forEach(function(method) {
    self[method] = wrapMethod(method, 1, setUnsynced, syncModes.RENAME);
  });

  // Wrapped fs methods that use file descriptors
  ['ftruncate', 'futimes', 'write'].forEach(function(method) {
    self[method] = wrapMethod(method, 0, fsetUnsynced, syncModes.CREATE);
  });

  // Wrapped fs methods that have path at first arg position and use parent
  // path for writing unsynced metadata (i.e., removes node)
  ['rmdir', 'unlink'].forEach(function(method) {
    self[method] = wrapMethod(method, 0, setUnsynced, syncModes.DELETE);
  });

  // We also want to do extra work in the case of a rename.
  // If a file is a conflicted copy, and a rename is done,
  // remove the conflict.
  var rename = self.rename;
  self.rename = function(oldPath, newPath, callback) {
    rename(oldPath, newPath, function(err) {
      if(err) {
        return callback(err);
      }

      conflict.isConflictedCopy(fs, newPath, function(err, conflicted) {
        if(err) {
          return callback(err);
        }

        if(conflicted) {
          conflict.removeFileConflict(fs, newPath, callback);
        } else {
          callback();
        }
      });
    });
  };

  // Expose fs.Shell() but use wrapped sync filesystem instance vs fs.
  // This is a bit brittle, but since Filer doesn't expose the Shell()
  // directly, we deal with it by doing a deep require into Filer's code
  // ourselves. The other down side of this is that we're now including
  // the Shell code twice (once in filer.js, once here). We need to
  // optimize this when we look at making MakeDrive smaller.
  self.Shell = function(options) {
    return new Shell(self, options);
  };

  // Expose extra operations for checking whether path/fd is unsynced
  self.getUnsynced = function(path, callback) {
    fsUtils.getUnsynced(fs, path, callback);
  };
  self.fgetUnsynced = function(fd, callback) {
    fsUtils.fgetUnsynced(fs, fd, callback);
  };
}

module.exports = SyncFileSystem;
