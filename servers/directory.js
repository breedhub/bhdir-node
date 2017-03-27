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
        return [ 'id', 'ctime', 'mtime' ];
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

                this.dataDir = path.join(this.rootDir, 'data');
                this.stateDir = path.join(this.rootDir, 'state');

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
                );
            })
            .then(() => {
                return this._filer.createDirectory(
                    this.dataDir,
                    { mode: this.dirMode, uid: this.user, gid: this.group }
                );
            })
            .then(() => {
                return this._filer.createDirectory(
                    this.stateDir,
                    { mode: this.dirMode, uid: this.user, gid: this.group }
                );
            })
            .then(() => {
                this._logger.debug('directory', 'Starting the server');

                let exists;
                try {
                    fs.accessSync(path.join(this.dataDir, '.bhdir.json'), fs.constants.F_OK);
                    exists = true;
                } catch (error) {
                    exists = false;
                }

                return new Promise((resolve, reject) => {
                        let tries = 0;
                        let retry = () => {
                            if (++tries > 3)
                                return reject(new Error('.bhdir.json is damaged'));

                            let upgrading = false;
                            this._filer.lockUpdate(
                                    path.join(this.dataDir, '.bhdir.json'),
                                    contents => {
                                        try {
                                            this.bhdirInfo = JSON.parse(contents);
                                            if (typeof this.bhdirInfo !== 'object')
                                                return Promise.reject(new Error('.bhdir.json is damaged'));
                                        } catch (error) {
                                            if (exists) {
                                                setTimeout(() => { retry(); }, 1000);
                                                return Promise.resolve(contents);
                                            }

                                            this.bhdirInfo = {};
                                        }

                                        if (!this.bhdirInfo.directory)
                                            this.bhdirInfo.directory = {};
                                        if (!this.bhdirInfo.directory.format)
                                            this.bhdirInfo.directory.format = 1;
                                        if (!this.bhdirInfo.directory.upgrading)
                                            this.bhdirInfo.directory.upgrading = false;

                                        if (this.bhdirInfo.directory.format !== 2) {
                                            upgrading = true;
                                            this.bhdirInfo.directory.format = 2;
                                            this.bhdirInfo.directory.upgrading = this._state.sessionId;
                                        }

                                        return Promise.resolve(JSON.stringify(this.bhdirInfo, undefined, 4) + '\n');
                                    },
                                    { mode: this.fileMode, uid: this.user, gid: this.group }
                                )
                                .then(() => {
                                    resolve(upgrading);
                                })
                                .catch(error => {
                                    reject(error);
                                });
                        };
                        retry();
                    })
                    .then(upgrading => {
                        if (!upgrading)
                            return;

                        let upgradeDir = dir => {
                            return new Promise((resolve, reject) => {
                                try {
                                    let stats = fs.statSync(dir);
                                    if (!stats.isDirectory())
                                        return resolve();
                                } catch (error) {
                                    return reject(error);
                                }

                                let processor;
                                try {
                                    let stats = fs.statSync(path.join(dir, '.vars.json'));
                                    if (stats.isFile()) {
                                        processor = this._filer.lockUpdate(
                                            path.join(dir, '.vars.json'),
                                            contents => {
                                                let json;
                                                try {
                                                    json = JSON.parse(contents);
                                                    if (typeof json !== 'object')
                                                        return Promise.resolve(contents);
                                                } catch (error) {
                                                    return Promise.resolve(contents);
                                                }

                                                let result = {};
                                                for (let key of Object.keys(json)) {
                                                    result[key] = {
                                                        id: uuid.v4(),
                                                        ctime: Math.round(Date.now() / 1000),
                                                        mtime: Math.round(Date.now() / 1000),
                                                        value: json[key],
                                                    };
                                                }

                                                return Promise.resolve(JSON.stringify(result, undefined, 4) + '\n');
                                            }
                                        );
                                    }
                                } catch (error) {
                                    // do nothing
                                }

                                Promise.resolve()
                                    .then(() => {
                                        if (processor)
                                            return processor;
                                    })
                                    .then(() => {
                                        let promises = [];
                                        let files = fs.readdirSync(dir);
                                        for (let file of files) {
                                            if (file[0] !== '.')
                                                promises.push(upgradeDir(path.join(dir, file)));
                                        }

                                        if (promises.length)
                                            return Promise.all(promises);
                                    })
                                    .then(() => {
                                        resolve();
                                    })
                                    .catch(error => {
                                        reject(error);
                                    })
                            });
                        };

                        return new Promise(resolve => {
                                setTimeout(resolve, 10 * 1000);
                            })
                            .then(() => {
                                return this._filer.lockRead(path.join(this.dataDir, '.bhdir.json'))
                                    .then(contents => {
                                        let json = JSON.parse(contents);
                                        if (json.directory.upgrading !== this._state.sessionId) {
                                            return this._app.info(
                                                'Directory is being upgraded by other daemon - restarting...\n',
                                                () => {
                                                    process.exit(200);
                                                }
                                            );
                                        }
                                    });
                            })
                            .then(() => {
                                return upgradeDir(this.dataDir);
                            })
                            .then(() => {
                                return this._filer.lockUpdate(
                                    path.join(this.dataDir, '.bhdir.json'),
                                    contents => {
                                        let json;
                                        try {
                                            json = JSON.parse(contents);
                                            if (typeof json !== 'object')
                                                return Promise.resolve(contents);
                                        } catch (error) {
                                            return Promise.resolve(contents);
                                        }

                                        if (json.directory)
                                            json.directory.upgrading = false;

                                        return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                                    }
                                );
                            });
                    })
                    .then(() => {
                        return this._filer.lockRead(path.join(this.dataDir, '.bhdir.json'))
                            .then(contents => {
                                let json = JSON.parse(contents);
                                if (json.directory.upgrading) {
                                    return this._app.info(
                                        'Directory is being upgraded by other daemon - restarting...\n',
                                        () => { process.exit(200); }
                                    );
                                }
                            });
                    });
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
     * Compare two values
     * @param {*} val1                              First
     * @param {*} val2                              Second
     * @return {boolean}
     */
    isEqual(val1, val2) {
        if (typeof val1 !== typeof val2)
            return false;

        if (typeof val1 === 'object')
            return JSON.stringify(val1) === JSON.stringify(val2);

        return val1 === val2;
    }

    /**
     * Wait for variable change
     * @param {string} filename                     Variable path
     * @param {number} timeout                      Timeout in ms, 0 for no timeout
     * @return {Promise}
     */
    wait(filename, timeout) {
        return this.get(filename)
            .then(info => {
                if (!info) {
                    info = {
                        value: null,
                        mtime: 0,
                    };
                }
                let waiting = this.waiting.get(filename);
                if (waiting && (!this.isEqual(waiting.value, info.value) || waiting.mtime !== info.mtime)) {
                    this.notify(filename, info);
                    waiting = null;
                }
                if (!waiting) {
                    waiting = info;
                    waiting.handlers = new Set();
                    this.waiting.set(filename, waiting);
                }

                return new Promise((resolve) => {
                    let cb = (timeout, value) => {
                        this._logger.debug('directory', `Wait on ${filename} timeout: ${timeout}`);
                        resolve([ timeout, value ]);
                    };
                    info.handlers.add(cb);
                    if (timeout)
                        setTimeout(() => { cb(true, info.value); }, timeout);
                });
            })
            .catch(error => {
                this._logger.error(new WError(error, 'Directory.wait()'));
            });
    }

    /**
     * Notify about variable change
     * @param {string} filename                     Variable path
     * @param {object} info                         Variable
     */
    notify(filename, info) {
        let waiting = this.waiting.get(filename);
        if (!waiting || (this.isEqual(waiting.value, info.value) && waiting.mtime === info.mtime))
            return;

        for (let cb of waiting.handlers)
            cb(false, info.value);
        this.waiting.delete(filename);
    }

    /**
     * List variables
     * @param {string} filename                     Variable path
     * @return {Promise}
     */
    ls(filename) {
        this._logger.debug('directory', `Listing ${filename}`);

        let directory = path.join(this.dataDir, filename);

        try {
            fs.accessSync(path.join(directory, '.vars.json'), fs.constants.F_OK);
        } catch (error) {
            return Promise.resolve({});
        }

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
            })
            .then(json => {
                let result = {};
                for (let key of Object.keys(json))
                    result[key] = json[key]['value'];

                return result;
            });
    }

    /**
     * Set variable
     * @param {string} filename                     Variable path
     * @param {object} [info]                       Variable
     * @param {*} [value]                           Variable value if info is omitted
     * @return {Promise}                            Resolves to history id
     */
    set(filename, info, value) {
        this._logger.debug('directory', `Setting ${filename}`);

        let name = path.basename(filename);
        let directory = path.join(this.dataDir, path.dirname(filename));

        return this.get(filename, false)
            .then(old => {
                if (old && (typeof value !== 'undefined') && this.isEqual(old.value, value))
                    return null;

                if (!info)
                    info = old;
                if (!info)
                    info = {};

                info.mtime = Math.round(Date.now() / 1000);
                if (!info.ctime)
                    info.ctime = info.mtime;
                if (!info.id)
                    info.id = uuid.v4();
                if (typeof value !== 'undefined')
                    info.value = value;

                return this._cacher.set(filename, info)
                    .then(() => {
                        return this._filer.createDirectory(
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
                                                json[name] = info;
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
                                return this.addHistory(filename, info);
                            })
                            .then(id => {
                                this.notify(filename, info);
                                return id;
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
     * @param {boolean} [cacheResult=true]          Cache result
     * @return {Promise}
     */
    get(filename, cacheResult = true) {
        this._logger.debug('directory', `Getting ${filename}`);

        let name = path.basename(filename);
        let directory = path.join(this.dataDir, path.dirname(filename));

        return this._cacher.get(filename)
            .then(info => {
                if (typeof info !== 'undefined')
                    return info;

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
                        if (!cacheResult)
                            return json[name];

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
                        return this._filer.remove(path.join(filename, '.history'))
                            .catch(() => {
                                // do nothing
                            });
                    })
                    .then(() => {
                        this.notify(filename, { value: null, mtime: Math.round(Date.now() / 1000) });
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
        return this.setAttr(filename, 'mtime', Math.round(Date.now() / 1000));
    }

    /**
     * Set attribute
     * @param {string} filename                     Variable path
     * @param {*} name                              Attribute name
     * @param {*} value                             Attribute value
     * @return {Promise}                            Resolves to history id
     */
    setAttr(filename, name, value) {
        this._logger.debug('directory', `Setting attribute ${name} of ${filename}`);

        return this.get(filename, false)
            .then(info => {
                if (!info)
                    return null;

                info[name] = value;
                return this.set(filename, info);
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

        return this.get(filename)
            .then(info => {
                if (!info)
                    return null;

                return typeof info[name] === 'undefined' ? null : info[name];
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

        return this.get(filename)
            .then(info => {
                if (!info)
                    return null;

                delete info[name];
                return this.set(filename, info);
            });
    }

    /**
     * Add history record
     * @param {string} filename                     Variable path
     * @param {object} info                         Variable
     * @return {Promise}                            Resolves to id
     */
    addHistory(filename, info) {
        this._logger.debug('directory', `Adding to history of ${filename}`);

        let now = new Date();
        let mtime = Math.round(now.getTime() / 1000);
        let directory = path.join(
            this.dataDir,
            filename,
            '.history',
            now.getUTCFullYear().toString(),
            this._padNumber(now.getUTCMonth() + 1, 2),
            this._padNumber(now.getUTCDate(), 2),
            this._padNumber(now.getUTCHours(), 2)
        );

        let json = {
            id: uuid.v4(),
            mtime: mtime,
            variable: info,
        };

        return this._filer.createDirectory(
            directory,
            { mode: this.dirMode, uid: this.user, gid: this.group }
            )
            .then(() => {
                let name;
                let files = fs.readdirSync(directory);
                let numbers = [];
                let re = /^(\d+)\.json$/;
                for (let file of files) {
                    let result = re.exec(file);
                    if (!result)
                        continue;
                    numbers.push(parseInt(result[1]));
                }
                if (numbers.length) {
                    numbers.sort();
                    name = this._padNumber(numbers[numbers.length - 1] + 1, 4);
                } else {
                    name = '0001';
                }
                name = name + '.json';

                return this._filer.lockWrite(
                    path.join(directory, name),
                    JSON.stringify(json, undefined, 4) + '\n',
                    {mode: this.fileMode, uid: this.user, gid: this.group}
                );
            })
            .then(() => {
                return json.id;
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
     * Pad number with zeros
     * @param {number} value
     * @param {number} length
     */
    _padNumber(value, length) {
        let result = value.toString();
        while (result.length < length)
            result = '0' + result;
        return result;
    }

    /**
     * Retrieve state server
     * @return {State}
     */
    get _state() {
        if (this._state_instance)
            return this._state_instance;
        this._state_instance = this._app.get('servers').get('state');
        return this._state_instance;
    }
}

module.exports = Directory;
