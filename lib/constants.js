module.exports = {
  rsyncDefaults: {
    size: 5,
    time: true,
    recursive: true
  },

  attributes: {
    unsynced: 'makedrive-unsynced',
    conflict: 'makedrive-conflict',
    checksum: 'makedrive-checksum',
    partial:  'makedrive-partial',
    pathsToSync: 'makedrive-pathsToSync'
  },

  // Sync Mode constants
  syncModes: {
    CREATE: 'create',
    RENAME: 'rename',
    DELETE: 'delete'
  },

  server: {
    syncChannel: 'makedrive-sync',
    lockRequestChannel: 'makedrive-lock-request',
    lockResponseChannel: 'makedrive-lock-response',
    states: {
      CREATED: 'CREATED',
      CLOSED: 'CLOSED',
      CLOSING: 'CLOSING',
      CONNECTING: 'CONNECTING',
      LISTENING: 'LISTENING',
      INIT: 'INIT',
      OUT_OF_DATE: 'OUT_OF_DATE',
      CHKSUM: 'CHKSUM',
      PATCH: 'PATCH',
      ERROR: 'ERROR'
    }
  }
};
