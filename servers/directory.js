/**
 * Directory data server
 * @module servers/directory
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
const uuid = require('uuid');
const crypto = require('crypto');
const EventEmitter = require('events');
const WError = require('verror').WError;

/**
 * Server class
 */
class Directory extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                     Application
     * @param {object} config               Configuration
     * @param {Logger} logger               Logger service
     * @param {Filer} filer                 Filer service
     * @param {Runner} runner               Runner service
     * @param {RedisClient} redis           Redis service
     * @param {Cacher} cacher               Cacher service
     */
    constructor(app, config, logger, filer, runner, redis, cacher) {
        super();

        this.waiting = new Map();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
        this._runner = runner;
        this._redis = redis;
        this._cacher = cacher;
    }

    /**
     * Service name is 'servers.directory'
     * @type {string}
     */
    static get provides() {
        return 'servers.directory';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'filer', 'runner', 'redis', 'cacher' ];
    }

    /**
     * Retry reading/writing ofter waiting this much
     * @type {number}
     */
    static get dataRetryInterval() {
        return 1000; // ms
    }

    /**
     * Retry reading/writing this many times
     * @type {number}
     */
    static get dataRetryMax() {
        return 5;
    }

    /**
     * Protected attributes
     * @type {string[]}
     */
    static get protectedAttrs() {
        return [ 'ctime', 'mtime' ];
    }
    /**
     * Initialize the server
     * @param {string} name                     Config section name
     * @return {Promise}
     */
    init(name) {
        this._name = name;
        return Promise.resolve()
            .then(() => {
                let configPath = (os.platform() === 'freebsd' ? '/usr/local/etc/bhdir' : '/etc/bhdir');
                try {
                    fs.accessSync(path.join(configPath, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    throw new Error('Could not read bhdir.conf');
                }

                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configPath, 'bhdir.conf'), 'utf8'));
                this.rootDir = bhdirConfig.directory && bhdirConfig.directory.root;
                if (!this.rootDir)
                    throw new Error('No root parameter in directory section of bhdir.conf');

                this.updatesDir = path.join(this.rootDir, 'updates');
                this.dataDir = path.join(this.rootDir, 'data');

                this.dirMode = parseInt((bhdirConfig.directory && bhdirConfig.directory.dir_mode) || '770', 8);
                if (isNaN(this.dirMode))
                    this.dirMode = null;
                this.fileMode = parseInt((bhdirConfig.directory && bhdirConfig.directory.file_mode) || '660', 8);
                if (isNaN(this.fileMode))
                    this.fileMode = null;

                let user = (bhdirConfig.directory && bhdirConfig.directory.user) || 'root';
                let group = (bhdirConfig.directory && bhdirConfig.directory.group) || (os.platform() === 'freebsd' ? 'wheel' : 'root');

                let syncUser = (bhdirConfig.resilio && bhdirConfig.resilio.user) || 'root';
                this.syncLog = bhdirConfig.resilio && bhdirConfig.resilio.sync_log;

                let updateConf = false;
                if ((bhdirConfig.daemon && bhdirConfig.daemon.log_level) !== 'debug') {
                    if (!bhdirConfig.daemon)
                        bhdirConfig.daemon = {};
                    bhdirConfig.daemon.log_level = 'debug';
                    updateConf = true;
                }
                if (user === '999' || group === '999' || group === 'rslsync') { // TODO: Remove this
                    if (!bhdirConfig.directory)
                        bhdirConfig.directory = {};
                    user = bhdirConfig.directory.user = 'rslsync';
                    group = bhdirConfig.directory.group = 'bhdir';
                    updateConf = true;
                }
                if (!syncUser) {
                    if (!bhdirConfig.resilio)
                        bhdirConfig.resilio = {};
                    bhdirConfig.resilio.user = 'rslsync';
                    updateConf = true;
                }
                if (!this.syncLog) {
                    if (!bhdirConfig.resilio)
                        bhdirConfig.resilio = {};
                    bhdirConfig.resilio.sync_log = '/var/lib/resilio-sync/sync.log';
                    updateConf = true;
                }

                if (updateConf) {
                    fs.writeFileSync(path.join(configPath, 'bhdir.conf'), ini.stringify(bhdirConfig));
                    return this._app.info('Settings updated - restarting\n')
                        .then(() => {
                            process.exit(200);
                        });
                }

                return Promise.all([
                        this._runner.exec('grep', [ '-E', `^${user}:`, '/etc/passwd' ]),
                        this._runner.exec('grep', [ '-E', `^${group}:`, '/etc/group' ]),
                        this._runner.exec('grep', [ '-E', `^${syncUser}:`, '/etc/passwd' ]),
                    ])
                    .then(([ userInfo, groupInfo, syncUserInfo ]) => {
                        if (user.length && parseInt(user).toString() === user) {
                            this.user = parseInt(user);
                        } else {
                            let userDb = userInfo.stdout.trim().split(':');
                            if (userInfo.code !== 0 || userDb.length !== 7) {
                                this.user = null;
                                this._logger.error(`Directory user ${user} not found`);
                            } else {
                                this.user = parseInt(userDb[2]);
                            }
                        }

                        if (group.length && parseInt(group).toString() === group) {
                            this.group = parseInt(group);
                        } else {
                            let groupDb = groupInfo.stdout.trim().split(':');
                            if (groupInfo.code !== 0 || groupDb.length !== 4) {
                                this.group = null;
                                this._logger.error(`Directory group ${group} not found`);
                            } else {
                                this.group = parseInt(groupDb[2]);
                            }
                        }

                        if (syncUser.length && parseInt(syncUser).toString() === syncUser) {
                            this.syncUser = parseInt(syncUser);
                        } else {
                            let syncUserDb = syncUserInfo.stdout.trim().split(':');
                            if (syncUserInfo.code !== 0 || syncUserDb.length !== 7) {
                                this.syncUser = null;
                                this._logger.error(`Resilio user ${syncUser} not found`);
                            } else {
                                this.syncUser = parseInt(syncUserDb[2]);
                            }
                        }
                    });
            });
    }

    /**
     * Start the server
     * @param {string} name                     Config section name
     * @return {Promise}
     */
    start(name) {
        if (name !== this._name)
            return Promise.reject(new Error(`Server ${name} was not properly initialized`));

        return Array.from(this._app.get('modules')).reduce(
                (prev, [ curName, curModule ]) => {
                    return prev.then(() => {
                        if (!curModule.register)
                            return;

                        let result = curModule.register(name);
                        if (result === null || typeof result !== 'object' || typeof result.then !== 'function')
                            throw new Error(`Module '${curName}' register() did not return a Promise`);
                        return result;
                    });
                },
                Promise.resolve()
            )
            .then(() => {
                if (!this.group)
                    return;

                if (os.platform() === 'freebsd')
                    return this._runner.exec('pw', [ 'groupadd', this.group ]);

                return this._runner.exec('groupadd', [ this.group ]);
            })
            .then(() => {
                if (!this.group || !this.syncUser)
                    return;

                if (os.platform() === 'freebsd')
                    return this._runner.exec('pw', [ 'groupmod', this.group, '-m', this.syncUser ]);

                return this._runner.exec('usermod', [ '-G', this.group, '-a', this.syncUser ]);
            })
            .then(() => {
                return this._filer.createDirectory(
                    this.rootDir,
                    { mode: this.dirMode, uid: this.user, gid: this.group }
                )
            })
            .then(() => {
                return this._filer.createDirectory(
                    this.dataDir,
                    { mode: this.dirMode, uid: this.user, gid: this.group }
                )
            })
            .then(() => {
                return this._filer.createDirectory(
                    this.updatesDir,
                    { mode: this.dirMode, uid: this.user, gid: this.group }
                )
            });
    }

    /**
     * Set variable
     * @param {string} filename                     Variable path
     * @return {boolean}
     */
    validatePath(filename) {
        if (typeof filename !== 'string')
            return false;

        return (
            filename.length &&
            filename[0] === '/' &&
            filename[filename.length - 1] !== '/' &&
            filename.indexOf('/.') === -1
        );
    }

    /**
     * Compare two variables
     * @param {*} var1                              First
     * @param {*} var2                              Second
     * @return {boolean}
     */
    isEqual(var1, var2) {
        if (typeof var1 !== typeof var2)
            return false;

        if (typeof var1 === 'object')
            return JSON.stringify(var1) === JSON.stringify(var2);

        return var1 === var2;
    }

    /**
     * Wait for variable change
     * @param {string} filename                     Variable path
     * @param {number} timeout                      Timeout in ms, 0 for no timeout
     * @return {Promise}
     */
    wait(filename, timeout) {
        return Promise.all([
                this.get(filename),
                this.getAttr(filename, 'mtime')
            ])
            .then(([ result, mtime ]) => {
                if (typeof result === 'undefined')
                    result = null;
                let info = this.waiting.get(filename);
                if (info && (!this.isEqual(info.value, result) || info.mtime !== mtime)) {
                    this.notify(filename, result, mtime);
                    info = null;
                }
                if (!info) {
                    info = {
                        value: result,
                        mtime: mtime,
                        handlers: new Set(),
                    };
                    this.waiting.set(filename, info);
                }

                return new Promise((resolve) => {
                    let cb = (timeout, value) => {
                        this._logger.debug('directory', `Wait on ${filename} timeout: ${timeout}`);
                        resolve([ timeout, value ]);
                    };
                    info.handlers.add(cb);
                    if (timeout)
                        setTimeout(() => { cb(true, result); }, timeout);
                });
            })
            .catch(error => {
                this._logger.error(new WError(error, 'Directory.wait()'));
            });
    }

    /**
     * Notify about variable change
     * @param {string} filename                     Variable path
     * @param {*} value                             Variable value
     * @param {number} mtime                        Variable mtime
     */
    notify(filename, value, mtime) {
        if (typeof value === 'undefined')
            value = null;

        let waiting = this.waiting.get(filename);
        if (!waiting || (this.isEqual(waiting.value, value) && waiting.mtime === mtime))
            return;

        for (let cb of waiting.handlers)
            cb(false, value);
        this.waiting.delete(filename);
    }

    /**
     * Set variable
     * @param {string} filename                     Variable path
     * @param {*} value                             Variable value
     * @return {Promise}
     */
    set(filename, value) {
        this._logger.debug('directory', `Setting ${filename}`);

        if (value === null) {
            this._logger.error(`Could not set ${filename} to null`);
            return Promise.resolve();
        }

        let name = path.basename(filename);
        let directory = path.join(this.dataDir, path.dirname(filename));

        return this.get(filename)
            .then(result => {
                if (this.isEqual(result, value))
                    return;

                return this._cacher.set(filename, value)
                    .then(() => {
                        this._filer.createDirectory(
                                directory,
                                { mode: this.dirMode, uid: this.user, gid: this.group }
                            )
                            .then(() => {
                                let exists;
                                try {
                                    fs.accessSync(path.join(directory, '.vars.json'), fs.constants.F_OK);
                                    exists = true;
                                } catch (error) {
                                    exists = false;
                                }

                                return new Promise((resolve, reject) => {
                                    let tries = 0;
                                    let retry = () => {
                                        if (++tries > this.constructor.dataRetryMax)
                                            return reject(new Error(`Max retries reached while setting ${filename}`));

                                        let success = false;
                                        this._filer.lockUpdate(
                                            path.join(directory, '.vars.json'),
                                            contents => {
                                                let json;
                                                try {
                                                    json = JSON.parse(contents);
                                                } catch (error) {
                                                    if (exists)
                                                        return Promise.resolve(contents);
                                                    json = {};
                                                }

                                                success = true;
                                                json[name] = value;
                                                return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                                            },
                                            { mode: this.fileMode, uid: this.user, gid: this.group }
                                            )
                                            .then(() => {
                                                if (success)
                                                    return resolve();

                                                setTimeout(() => { retry(); }, this.constructor.dataRetryInterval);
                                            })
                                            .catch(error => {
                                                reject(error);
                                            });
                                    };
                                    retry();
                                });
                            })
                            .then(() => {
                                let now = Math.round(Date.now() / 1000);
                                return this.setAttr(filename, 'mtime', now)
                                    .then(() => {
                                        this.notify(filename, value, now);
                                    });
                            })
                            .catch(error => {
                                this._logger.error(`FS error: ${error.message}`);
                            });
                    });
            });
    }

    /**
     * Get variable
     * @param {string} filename                     Variable path
     * @return {Promise}
     */
    get(filename) {
        this._logger.debug('directory', `Getting ${filename}`);

        let name = path.basename(filename);
        let directory = path.join(this.dataDir, path.dirname(filename));

        return this._cacher.get(filename)
            .then(result => {
                if (typeof result !== 'undefined')
                    return result;

                let exists;
                try {
                    fs.accessSync(path.join(directory, '.vars.json'), fs.constants.F_OK);
                    exists = true;
                } catch (error) {
                    exists = false;
                }

                return Promise.resolve()
                    .then(() => {
                        if (!exists)
                            return {};

                        return new Promise((resolve, reject) => {
                            let tries = 0;
                            let retry = () => {
                                if (++tries > this.constructor.dataRetryMax)
                                    return reject(new Error(`Max retries reached while getting ${filename}`));

                                this._filer.lockRead(path.join(directory, '.vars.json'))
                                    .then(contents => {
                                        let json;
                                        try {
                                            json = JSON.parse(contents);
                                        } catch (error) {
                                            setTimeout(() => { retry(); }, this.constructor.dataRetryInterval);
                                            return;
                                        }

                                        resolve(json);
                                    })
                                    .catch(error => {
                                        reject(error);
                                    });
                            };
                            retry();
                        });
                    })
                    .then(json => {
                        return this._cacher.set(filename, typeof json[name] === 'undefined' ? null : json[name])
                            .then(() => {
                                return json[name];
                            });
                    });
            });
    }

    /**
     * Delete variable
     * @param {string} filename                     Variable path
     * @return {Promise}
     */
    del(filename) {
        this._logger.debug('directory', `Deleting ${filename}`);

        let name = path.basename(filename);
        let directory = path.join(this.dataDir, path.dirname(filename));

        return this._cacher.unset(filename)
            .then(() => {
                this._filer.createDirectory(
                        directory,
                        { mode: this.dirMode, uid: this.user, gid: this.group }
                    )
                    .then(() => {
                        try {
                            fs.accessSync(path.join(directory, '.vars.json'), fs.constants.F_OK);
                        } catch (error) {
                            return;
                        }

                        return new Promise((resolve, reject) => {
                            let tries = 0;
                            let retry = () => {
                                if (++tries > this.constructor.dataRetryMax)
                                    return reject(new Error(`Max retries reached while deleting ${filename}`));

                                let success = false;
                                this._filer.lockUpdate(
                                        path.join(directory, '.vars.json'),
                                        contents => {
                                            let json;
                                            try {
                                                json = JSON.parse(contents);
                                            } catch (error) {
                                                return Promise.resolve(contents);
                                            }

                                            success = true;
                                            delete json[name];
                                            return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                                        },
                                        { mode: this.fileMode, uid: this.user, gid: this.group }
                                    )
                                    .then(() => {
                                        if (success)
                                            return resolve();

                                        setTimeout(() => { retry(); }, this.constructor.dataRetryInterval);
                                    })
                                    .catch(error => {
                                        reject(error);
                                    });
                            };
                            retry();
                        });
                    })
                    .then(() => {
                        let now = Math.round(Date.now() / 1000);
                        this.notify(filename, null, now);
                    })
                    .catch(error => {
                        this._logger.error(`FS error: ${error.message}`);
                    });
            });
    }

    /**
     * Signal variable change
     * @param {string} filename                     Variable path
     * @return {Promise}
     */
    touch(filename) {
        let now = Math.round(Date.now() / 1000);
        return this.setAttr(filename, 'mtime', now)
            .then(() => {
                let waiting = this.waiting.get(filename);
                if (!waiting)
                    return;

                for (let cb of waiting.handlers)
                    cb(false, waiting.value);
                this.waiting.delete(filename);
            });
    }

    /**
     * Set attribute
     * @param {string} filename                     Variable path
     * @param {*} name                              Attribute name
     * @param {*} value                             Attribute value
     * @return {Promise}
     */
    setAttr(filename, name, value) {
        this._logger.debug('directory', `Setting attribute ${name} of ${filename}`);

        if (value === null) {
            this._logger.error(`Could not set attribute ${name} of ${filename} to null`);
            return Promise.resolve();
        }

        return this._filer.createDirectory(
                path.join(this.dataDir, filename),
                { mode: this.dirMode, uid: this.user, gid: this.group }
            )
            .then(() => {
                let exists;
                try {
                    fs.accessSync(path.join(this.dataDir, filename, '.attrs.json'), fs.constants.F_OK);
                    exists = true;
                } catch (error) {
                    exists = false;
                }

                return new Promise((resolve, reject) => {
                    let tries = 0;
                    let retry = () => {
                        if (++tries > this.constructor.dataRetryMax)
                            return reject(new Error(`Max retries reached while setting attribute ${name} of ${filename}`));

                        let success = false;
                        this._filer.lockUpdate(
                                path.join(this.dataDir, filename, '.attrs.json'),
                                contents => {
                                    let json;
                                    try {
                                        json = JSON.parse(contents);
                                    } catch (error) {
                                        if (exists)
                                            return Promise.resolve(contents);
                                        json = {};
                                    }

                                    this._initAttrs(json);

                                    success = true;
                                    json[name] = value;

                                    return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                                },
                                { mode: this.fileMode, uid: this.user, gid: this.group }
                            )
                            .then(() => {
                                if (success)
                                    return resolve();

                                setTimeout(() => { retry(); }, this.constructor.dataRetryInterval);
                            })
                            .catch(error => {
                                reject(error);
                            });
                    };
                    retry();
                });
            });
    }

    /**
     * Get attribute
     * @param {string} filename                     Variable path
     * @param {string} name                         Attribute name
     * @return {Promise}
     */
    getAttr(filename, name) {
        this._logger.debug('directory', `Getting attribute ${name} of ${filename}`);

        let exists;
        try {
            fs.accessSync(path.join(this.dataDir, filename, '.attrs.json'), fs.constants.F_OK);
            exists = true;
        } catch (error) {
            exists = false;
        }

        return Promise.resolve()
            .then(() => {
                if (!exists)
                    return {};

                return new Promise((resolve, reject) => {
                    let tries = 0;
                    let retry = () => {
                        if (++tries > this.constructor.dataRetryMax)
                            return reject(new Error(`Max retries reached while getting attribute ${name} of ${filename}`));

                        this._filer.lockRead(path.join(this.dataDir, filename, '.attrs.json'))
                            .then(contents => {
                                let json;
                                try {
                                    json = JSON.parse(contents);
                                } catch (error) {
                                    setTimeout(() => { retry(); }, this.constructor.dataRetryInterval);
                                    return;
                                }

                                resolve(json);
                            })
                            .catch(error => {
                                reject(error);
                            });
                    };
                    retry();
                });
            })
            .then(json => {
                return typeof json[name] === 'undefined' ? null : json[name];
            });
    }

    /**
     * Delete attribute
     * @param {string} filename                     Variable path
     * @param {string} name                         Attribute name
     * @return {Promise}
     */
    delAttr(filename, name) {
        this._logger.debug('directory', `Deleting attribute ${name} of ${filename}`);

        return this._filer.createDirectory(
                path.join(this.dataDir, filename),
                { mode: this.dirMode, uid: this.user, gid: this.group }
            )
            .then(() => {
                try {
                    fs.accessSync(path.join(this.dataDir, filename, '.attrs.json'), fs.constants.F_OK);
                } catch (error) {
                    return;
                }

                return new Promise((resolve, reject) => {
                    let tries = 0;
                    let retry = () => {
                        if (++tries > this.constructor.dataRetryMax)
                            return reject(new Error(`Max retries reached while deleting attribute ${name} of ${filename}`));

                        let success = false;
                        this._filer.lockUpdate(
                                path.join(this.dataDir, filename, '.attrs.json'),
                                contents => {
                                    let json;
                                    try {
                                        json = JSON.parse(contents);
                                    } catch (error) {
                                        return Promise.resolve(contents);
                                    }

                                    this._initAttrs(json);

                                    success = true;
                                    delete json[name];
                                    return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                                },
                                { mode: this.fileMode, uid: this.user, gid: this.group }
                            )
                            .then(() => {
                                if (success)
                                    return resolve();

                                setTimeout(() => { retry(); }, this.constructor.dataRetryInterval);
                            })
                            .catch(error => {
                                reject(error);
                            });
                    };
                    retry();
                });
            });
    }

    /**
     * Clear cache
     * @return {Promise}
     */
    clearCache() {
        this._logger.debug('directory', `Clearing cache`);
        return this._redis.connect(this._config.get('cache.redis'))
            .then(client => {
                return client.query('FLUSHDB')
                    .then(() => {
                        client.done();
                    })
            });
    }

    /**
     * Init attributes
     * @param {object} json                             Attributes
     */
    _initAttrs(json) {
        if (!json['id'])
            json['id'] = uuid.v4();
        if (!json['ctime'])
            json['ctime'] = Math.round(Date.now() / 1000);
    }

    /**
     * Retrieve watcher server
     * @return {Watcher}
     */
    get _watcher() {
        if (this._watcher_instance)
            return this._watcher_instance;
        this._watcher_instance = this._app.get('servers').get('watcher');
        return this._watcher_instance;
    }
}

module.exports = Directory;
