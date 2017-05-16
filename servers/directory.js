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
     * @param {Util} util                   Util service
     */
    constructor(app, config, logger, filer, runner, redis, cacher, util) {
        super();

        this.default = null;
        this.directories = new Map();
        this.waiting = new Map();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
        this._runner = runner;
        this._redis = redis;
        this._cacher = cacher;
        this._util = util;
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
        return [ 'app', 'config', 'logger', 'filer', 'runner', 'redis', 'cacher', 'util' ];
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
        return [ 'id', 'value', 'ctime', 'mtime' ];
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

                let updateConf = false;
                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configPath, 'bhdir.conf'), 'utf8'));

                if (bhdirConfig.directory) {
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

                    if (user === '999' || group === '999' || group === 'rslsync') { // TODO: Remove this
                        if (!bhdirConfig.directory)
                            bhdirConfig.directory = {};
                        user = bhdirConfig.directory.user = 'rslsync';
                        group = bhdirConfig.directory.group = 'bhdir';
                    }

                    bhdirConfig['sync:directory'] = bhdirConfig.directory;
                    bhdirConfig['sync:directory'].default = true;
                    delete bhdirConfig.directory;
                    updateConf = true;
                } else {
                    for (let group of Object.keys(bhdirConfig)) {
                        let index = group.indexOf(':directory');
                        if (index === -1)
                            continue;

                        let name = group.substring(0, index);
                        let info = {};
                        info.rootDir = bhdirConfig[group].root;
                        if (!info.rootDir) {
                            this._logger.error(`No root parameter in ${name} directory section of bhdir.conf`);
                            continue;
                        }

                        info.dataDir = path.join(info.rootDir, 'data');
                        info.stateDir = path.join(info.rootDir, 'state');

                        info.dirMode = parseInt(bhdirConfig[group].dir_mode || '770', 8);
                        if (isNaN(info.dirMode))
                            info.dirMode = null;
                        info.fileMode = parseInt(bhdirConfig[group].file_mode || '660', 8);
                        if (isNaN(info.fileMode))
                            info.fileMode = null;

                        info.user = bhdirConfig[group].user || 'root';
                        info.group = bhdirConfig[group].group || (os.platform() === 'freebsd' ? 'wheel' : 'root');

                        this.directories.set(name, info);
                        if (bhdirConfig[group].default === true || bhdirConfig[group].default === 'yes')
                            this.default = name;
                    }
                }

                if ((bhdirConfig.daemon && bhdirConfig.daemon.log_level) !== 'debug') {
                    if (!bhdirConfig.daemon)
                        bhdirConfig.daemon = {};
                    bhdirConfig.daemon.log_level = 'debug';
                    updateConf = true;
                }

                this.syncBin = (bhdirConfig.resilio && bhdirConfig.resilio.bin) || '/usr/bin/rslsync';
                this.syncConfig = os.platform() === 'freebsd' ? '/usr/local/etc/rslsync/rslsync.conf' : '/etc/resilio-sync/config.json';
                this.syncUser = bhdirConfig.resilio && bhdirConfig.resilio.user;
                this.syncLog = bhdirConfig.resilio && bhdirConfig.resilio.sync_log;
                if (!this.syncUser) {
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

                this.socketMode = parseInt((bhdirConfig.socket && bhdirConfig.socket.mode) || '0', 8);
                this.socketUser = bhdirConfig.socket && bhdirConfig.socket.user;
                this.socketGroup = bhdirConfig.socket && bhdirConfig.socket.group;
                if (!this.socketMode || isNaN(this.socketMode)) {
                    if (!bhdirConfig.socket)
                        bhdirConfig.socket = {};
                    bhdirConfig.socket.mode = '660';
                    updateConf = true;
                }
                if (!this.socketUser) {
                    if (!bhdirConfig.socket)
                        bhdirConfig.socket = {};
                    bhdirConfig.socket.user = 'root';
                    updateConf = true;
                }
                if (!this.socketGroup) {
                    if (!bhdirConfig.socket)
                        bhdirConfig.socket = {};
                    bhdirConfig.socket.group = 'bhdir';
                    updateConf = true;
                }

                if (updateConf) {
                    fs.writeFileSync(path.join(configPath, 'bhdir.conf'), ini.stringify(bhdirConfig));
                    return this._app.info('Settings updated - restarting\n')
                        .then(() => {
                            process.exit(255);
                        });
                }

                return Array.from(this.directories.keys()).reduce(
                    (prev, cur) => {
                        return prev.then(() => {
                            return this._startFolder(cur);
                        });
                    },
                    Promise.resolve()
                )
            })
            .then(() => {
                return Promise.all([
                    this._runner.exec('grep', [ '-E', `^${this.socketUser}:`, '/etc/passwd' ]),
                    this._runner.exec('grep', [ '-E', `^${this.socketGroup}:`, '/etc/group' ]),
                ]);
            })
            .then(([ userInfo, groupInfo ]) => {
                let userDb = userInfo.stdout.trim().split(':');
                if (userInfo.code !== 0 || userDb.length !== 7) {
                    this._logger.error(`Socket user ${this.socketUser} not found`);
                    this.socketUser = null;
                    this.socketUid = null;
                } else {
                    this.socketUid = parseInt(userDb[2]);
                }

                let groupDb = groupInfo.stdout.trim().split(':');
                if (groupInfo.code !== 0 || groupDb.length !== 4) {
                    this._logger.error(`Socket group ${this.socketGroup} not found`);
                    this.socketGroup = null;
                    this.socketGid = null;
                } else {
                    this.socketGid = parseInt(groupDb[2]);
                }
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
                this._logger.debug('directory', 'Starting the server');
            });
    }

    /**
     * Set variable
     * @param {string} filename                     Variable path
     * @return {boolean}
     */
    validatePath(filename) {
        if (typeof filename !== 'string' || !filename.length)
            return false;

        let dir, name;
        if (filename[0] === '/') {
            if (!this.default)
                return false;
            dir = this.default;
            name = filename;
        } else {
            let parts = filename.split(':');
            dir = parts.shift();
            if (!parts.length)
                return false;
            name = parts.join(':');
        }

        let info = this.directories.get(dir);
        if (!info || !info.enabled)
            return false;

        if (name === '/')
            return true;

        return (
            name.length &&
            name[0] === '/' &&
            name[name.length - 1] !== '/' &&
            name.indexOf('/.') === -1
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
     * Get directory and filename from variable name
     * @param {string} variable                     Variable name
     * @return {Promise}                            Resolves to [ directory, filename ]
     */
    parseVariable(variable) {
        return new Promise((resolve, reject) => {
            if (!this.validatePath(variable))
                return reject(new Error('Invalid directory or path'));

            let dir, name;
            if (variable[0] === '/') {
                dir = this.default;
                name = variable;
            } else {
                let parts = variable.split(':');
                dir = parts.shift();
                name = parts.join(':');
            }

            resolve([ dir, name ]);
        });
    }

    /**
     * Create folder
     * @param {string} folder                       Folder name
     * @param {string} directory                    Folder path
     * @return {Promise}                            Resolves to { readwrite, readonly }
     */
    createFolder(folder, directory) {
        let readwrite, readonly, configPath, cwd = process.cwd(), info = {};
        process.chdir('/tmp');
        return this._runner.exec(this.syncBin, [ '--generate-secret' ])
            .then(result => {
                if (result.code !== 0)
                    throw new Error('Could not generate readwrite secret');

                readwrite = result.stdout.trim();
                return this._runner.exec(this.syncBin, [ '--get-ro-secret', readwrite ]);
            })
            .then(result => {
                if (result.code !== 0)
                    throw new Error('Could not generate readonly secret');

                readonly = result.stdout.trim();

                process.chdir(cwd);

                return this._filer.lockUpdate(
                    this.syncConfig,
                    contents => {
                        contents = contents.replace(/\/\/.*/g, '');
                        contents = contents.replace(/\/\*[\s\S]*?\*\//g, '');
                        let json = JSON.parse(contents);
                        if (!json.shared_folders)
                            json.shared_folders = [];
                        json.shared_folders.push(
                            {
                                secret: readwrite,
                                dir: directory,
                                use_relay_server: true,
                                search_lan: true,
                                use_sync_trash: false,
                                overwrite_changes: false,
                                selective_sync: false,
                            }
                        );
                        return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                    }
                );
            })
            .then(() => {
                configPath = (os.platform() === 'freebsd' ? '/usr/local/etc/bhdir' : '/etc/bhdir');
                try {
                    fs.accessSync(path.join(configPath, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    throw new Error('Could not read bhdir.conf');
                }

                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configPath, 'bhdir.conf'), 'utf8'));
                bhdirConfig[`${folder.replace(/\./g, '\\.')}:directory`] = {
                    default: 'no',
                    root: directory,
                    user: 'rslsync',
                    group: 'bhdir',
                    dir_mode: '770',
                    file_mode: '660',
                    cache_ttl: '300'
                };
                fs.writeFileSync(path.join(configPath, 'bhdir.conf'), ini.stringify(bhdirConfig));
            })
            .then(() => {
                info.rootDir = directory;
                info.dataDir = path.join(info.rootDir, 'data');
                info.stateDir = path.join(info.rootDir, 'state');

                info.dirMode = 0o770;
                info.fileMode = 0o660;
                info.user = 'rslsync';
                info.group = 'bhdir';

                this.directories.set(folder, info);

                return this._startFolder(folder);
            })
            .then(() => {
                let json = {
                    directory: {
                        format: 2,
                        upgrading: false,
                    },
                };

                return this._filer.lockWrite(
                    path.join(directory, 'data', '.bhdir.json'),
                    JSON.stringify(json, undefined, 4) + '\n',
                    { mode: info.fileMode, uid: info.uid, gid: info.gid }
                );
            })
            .then(() => {
                let json = {
                    hdepth: 1,
                    fdepth: 1,
                };

                return this._filer.lockWrite(
                    path.join(directory, 'data', '.root.json'),
                    JSON.stringify(json, undefined, 4) + '\n',
                    { mode: info.fileMode, uid: info.uid, gid: info.gid }
                );
            })
            .then(() => {
                this._index.add(folder, info);
                return { readwrite, readonly };
            })
            .catch(error => {
                process.chdir(cwd);
                throw error;
            });
    }

    /**
     * Add folder
     * @param {string} folder                       Folder name
     * @param {string} directory                    Folder path
     * @param {string} secret                       Secret
     * @param {boolean} tmp                         Temporary folder
     * @return {Promise}
     */
    addFolder(folder, directory, secret, tmp) {
        let configPath, info = {};
        return this._filer.lockUpdate(
                this.syncConfig,
                contents => {
                    contents = contents.replace(/\/\/.*/g, '');
                    contents = contents.replace(/\/\*[\s\S]*?\*\//g, '');
                    let json = JSON.parse(contents);
                    if (!json.shared_folders)
                        json.shared_folders = [];
                    json.shared_folders.push(
                        {
                            secret: secret,
                            dir: directory,
                            use_relay_server: true,
                            search_lan: true,
                            use_sync_trash: false,
                            overwrite_changes: false,
                            selective_sync: false,
                        }
                    );
                    return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                }
            )
            .then(() => {
                if (tmp)
                    return;

                configPath = (os.platform() === 'freebsd' ? '/usr/local/etc/bhdir' : '/etc/bhdir');
                try {
                    fs.accessSync(path.join(configPath, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    throw new Error('Could not read bhdir.conf');
                }

                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configPath, 'bhdir.conf'), 'utf8'));
                bhdirConfig[`${folder.replace(/\./g, '\\.')}:directory`] = {
                    default: 'no',
                    root: directory,
                    user: 'rslsync',
                    group: 'bhdir',
                    dir_mode: '770',
                    file_mode: '660',
                    cache_ttl: '300'
                };
                fs.writeFileSync(path.join(configPath, 'bhdir.conf'), ini.stringify(bhdirConfig));
            })
            .then(() => {
                info.rootDir = directory;
                info.dataDir = path.join(info.rootDir, 'data');
                info.stateDir = path.join(info.rootDir, 'state');

                info.dirMode = 0o770;
                info.fileMode = 0o660;
                info.user = 'rslsync';
                info.group = 'bhdir';

                this.directories.set(folder, info);

                return this._startFolder(folder);
            })
            .then(() => {
                this._index.add(folder, info);
            });
    }

    /**
     * Wait for variable change
     * @param {string} variable                     Variable name
     * @param {number} timeout                      Timeout in ms, 0 for no timeout
     * @return {Promise}
     */
    wait(variable, timeout) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename)
                    return [ false, null ];

                variable = `${repo}:${filename}`;

                return this.get(variable, false)
                    .then(info => {
                        if (!info) {
                            info = {
                                value: null,
                                mtime: 0,
                            };
                        }

                        let promise;

                        let waiting = this.waiting.get(variable);
                        if (waiting && (!this.isEqual(waiting.value, info.value) || waiting.mtime !== info.mtime)) {
                            promise = this.notify(variable, info);
                            waiting = null;
                        }
                        if (!waiting) {
                            waiting = info;
                            waiting.handlers = new Set();
                            this.waiting.set(variable, waiting);
                        }


                        return Promise.resolve()
                            .then(() => {
                                if (promise)
                                    return promise;
                            })
                            .then(() => {
                                return new Promise((resolve) => {
                                    let cb = (timeout, value) => {
                                        this._logger.debug('directory', `Wait on ${variable} timeout: ${timeout}`);
                                        resolve([ timeout, value ]);
                                    };
                                    waiting.handlers.add(cb);
                                    if (timeout)
                                        setTimeout(() => { cb(true, info.value); }, timeout);
                                });
                            });
                    })
            })
            .catch(error => {
                this._logger.error(new WError(error, 'Directory.wait()'));
            });
    }

    /**
     * Notify about variable change
     * @param {string} variable                     Variable name
     * @param {object} info                         Variable
     * @return {Promise}
     */
    notify(variable, info) {
        if (!info) {
            info = {
                value: null,
                mtime: 0,
            };
        }

        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename)
                    return;

                variable = `${repo}:${filename}`;

                let waiting = this.waiting.get(variable);
                if (!waiting || (this.isEqual(waiting.value, info.value) && waiting.mtime === info.mtime))
                    return;

                this._logger.debug('directory', `Notifying ${variable}`);

                for (let cb of waiting.handlers)
                    cb(false, info.value);

                this.waiting.delete(variable);
            });
    }

    /**
     * List variables
     * @param {string} variable                     Variable name
     * @return {Promise}
     */
    ls(variable) {
        this._logger.debug('directory', `Listing ${variable}`);

        return this.parseVariable(variable)
            .then(([ repo, filename ]) => {
                let info = this.directories.get(repo);
                let directory = path.join(info.dataDir, filename);

                try {
                    fs.accessSync(path.join(directory, '.vars.json'), fs.constants.F_OK);
                } catch (error) {
                    return Promise.resolve({});
                }

                return new Promise((resolve, reject) => {
                    let tries = 0;
                    let retry = () => {
                        if (++tries > this.constructor.dataRetryMax)
                            return reject(new Error(`Max retries reached while getting ${variable}`));

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
                    for (let key of Object.keys(json)) {
                        result[key] = json[key] ? json[key]['value'] : null;
                    }

                    return result;
                });
        });
    }

    /**
     * Set variable
     * @param {string} variable                     Variable name
     * @param {object} [attrs]                      Variable attributes
     * @param {*} [value]                           Variable value if info is omitted
     * @return {Promise}                            Resolves to history id
     */
    set(variable, attrs, value) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename)
                    return;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Setting ${variable}`);

                let parents = [];
                let parts = filename.split('/');
                for (let i = 2; i < parts.length; i++)
                    parents.push(parts.slice(0, i).join('/'));

                return parents.reduce(
                        (prev, cur) => {
                            return prev.then(() => {
                                return this.get(`${repo}:${cur}`)
                                    .then(val => {
                                        if (val)
                                            return;

                                        return this.set(`${repo}:${cur}`, null, null);
                                    });
                            });
                        },
                        Promise.resolve()
                    )
                    .then(() => {

                        let info = this.directories.get(repo);
                        let name = path.basename(filename);
                        let directory = path.join(info.dataDir, path.dirname(filename));

                        return this.get(variable, false, false)
                            .then(old => {
                                if (old && (typeof value !== 'undefined') && this.isEqual(old.value, value))
                                    return null;

                                if (!attrs)
                                    attrs = old;
                                if (!attrs)
                                    attrs = {};
                                this._initAttrs(attrs);
                                if (typeof value !== 'undefined')
                                    attrs.value = value;

                                return this._cacher.set(variable, attrs)
                                    .then(() => {
                                        return this._filer.createDirectory(
                                            directory,
                                            { mode: info.dirMode, uid: info.uid, gid: info.gid }
                                            )
                                            .then(() => {
                                                let exists;
                                                try {
                                                    fs.accessSync(path.join(directory, filename === '/' ? '.root.json' : '.vars.json'), fs.constants.F_OK);
                                                    exists = true;
                                                } catch (error) {
                                                    exists = false;
                                                }

                                                return new Promise((resolve, reject) => {
                                                    let tries = 0;
                                                    let retry = () => {
                                                        if (++tries > this.constructor.dataRetryMax)
                                                            return reject(new Error(`Max retries reached while setting ${variable}`));

                                                        let success = false;
                                                        this._filer.lockUpdate(
                                                            path.join(directory, filename === '/' ? '.root.json' : '.vars.json'),
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
                                                                if (name)
                                                                    json[name] = attrs;
                                                                else
                                                                    json = attrs;
                                                                return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                                                            },
                                                            { mode: info.fileMode, uid: info.uid, gid: info.gid }
                                                            )
                                                            .then(() => {
                                                                if (success)
                                                                    return resolve();

                                                                setTimeout(() => {
                                                                    retry();
                                                                }, this.constructor.dataRetryInterval);
                                                            })
                                                            .catch(error => {
                                                                reject(error);
                                                            });
                                                    };
                                                    retry();
                                                });
                                            })
                                            .then(() => {
                                                return this.addHistory(variable, attrs);
                                            })
                                            .then(id => {
                                                this._index.insert(
                                                    'variable',
                                                    this._index.constructor.binUuid(attrs.id),
                                                    {
                                                        directory: repo,
                                                        path: filename,
                                                    }
                                                );
                                                return this.notify(variable, attrs)
                                                    .then(() => {
                                                        return id;
                                                    });
                                            })
                                            .catch(error => {
                                                this._logger.error(`FS error: ${error.message}`);
                                            });
                                    });
                            });
                    });
            });
    }

    /**
     * Get variable
     * @param {string} variable                     Variable name
     * @param {boolean} [allowHistory=true]         Allow history lookup
     * @param {boolean} [cacheResult=true]          Cache result
     * @return {Promise}
     */
    get(variable, allowHistory = true, cacheResult = true) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search)
                    return [ null, null ];

                let choices = [ 'variable' ];
                if (allowHistory)
                    choices.push('history');
                if (choices.indexOf(search.type) === -1)
                    return [ null, null ];

                return [ search.directory, search.path, search.type, search.attr ];
            })
            .then(([ repo, filename, type, attr ]) => {
                if (!repo || !filename)
                    return null;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Getting ${variable}`);

                let info = this.directories.get(repo);
                if (type === 'history') {
                    return this._filer.lockRead(path.join(info.dataDir, attr))
                        .then(contents => {
                            return JSON.parse(contents).variable;
                        });
                }

                let name = path.basename(filename);
                let directory = path.join(info.dataDir, path.dirname(filename));

                return this._cacher.get(variable)
                    .then(attrs => {
                        if (typeof attrs !== 'undefined')
                            return attrs;

                        let exists;
                        try {
                            fs.accessSync(path.join(directory, filename === '/' ? '.root.json' : '.vars.json'), fs.constants.F_OK);
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
                                            return reject(new Error(`Max retries reached while getting ${variable}`));

                                        this._filer.lockRead(path.join(directory, filename === '/' ? '.root.json' : '.vars.json'))
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
                                let result = name ? (typeof json[name] === 'undefined' ? null : json[name]) : json;
                                if (!cacheResult)
                                    return result;

                                return this._cacher.set(variable, result)
                                    .then(() => {
                                        return result;
                                    });
                            });
                    });
            })
    }

    /**
     * Delete variable
     * @param {string} variable                     Variable name
     * @return {Promise}
     */
    del(variable) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename)
                    return;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Deleting ${variable}`);

                let id;
                let info = this.directories.get(repo);
                let name = path.basename(filename);
                let directory = path.join(info.dataDir, path.dirname(filename));

                return this._filer.createDirectory(
                        directory,
                        { mode: info.dirMode, uid: info.uid, gid: info.gid }
                    )
                    .then(() => {
                        try {
                            fs.accessSync(path.join(directory, filename === '/' ? '.root.json' : '.vars.json'), fs.constants.F_OK);
                        } catch (error) {
                            return;
                        }

                        return new Promise((resolve, reject) => {
                            let tries = 0;
                            let retry = () => {
                                if (++tries > this.constructor.dataRetryMax)
                                    return reject(new Error(`Max retries reached while deleting ${variable}`));

                                let success = false;
                                this._filer.lockUpdate(
                                        path.join(directory, filename === '/' ? '.root.json' : '.vars.json'),
                                        contents => {
                                            let json;
                                            try {
                                                json = JSON.parse(contents);
                                            } catch (error) {
                                                return Promise.resolve(contents);
                                            }

                                            success = true;
                                            if (name) {
                                                if (!json[name])
                                                    json[name] = {};
                                                this._initAttrs(json[name]);
                                                json[name].value = null;
                                                id = json[name]['id'];
                                            } else {
                                                this._initAttrs(json);
                                                json.value = null;
                                                id = json['id'];
                                            }
                                            return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                                        },
                                        { mode: info.fileMode, uid: info.uid, gid: info.gid }
                                    )
                                    .then(() => {
                                        if (success)
                                            return resolve();

                                        setTimeout(() => {
                                            retry();
                                        }, this.constructor.dataRetryInterval);
                                    })
                                    .catch(error => {
                                        reject(error);
                                    });
                            };
                            retry();
                        });
                    })
                    .then(() => {
                        return this.clearHistory(variable, 0);
                    })
                    .then(() => {
                        return this.clearFiles(variable, 0);
                    })
                    .then(() => {
                        if (id && this._util.isUuid(id))
                            return this._index.del(this._index.constructor.binUuid(id));
                    })
                    .then(() => {
                        return this._cacher.unset(variable);
                    })
                    .then(() => {
                        return this.notify(variable, {value: null, mtime: Math.round(Date.now() / 1000)});
                    })
                    .catch(error => {
                        this._logger.error(`FS error: ${error.message}`);
                    });
            });
    }

    /**
     * Remove a branch
     * @param {string} variable                     Variable name
     * @return {Promise}
     */
    rm(variable) {
        return this.del(variable)
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename || filename === '/')
                    return;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Removing ${variable}`);

                let info = this.directories.get(repo);
                return this._filer.process(
                        path.join(info.dataDir, filename),
                        file => {
                            let dir = path.dirname(file);
                            let base = path.basename(file);
                            if (dir.indexOf('/.') !== -1 || base !== '.vars.json')
                                return Promise.resolve();

                            return this._filer.lockRead(file)
                                .then(contents => {
                                    let json = JSON.parse(contents);
                                    let promises = [];
                                    for (let key of Object.keys(json))
                                        promises.push(this.del(repo + ':' + path.join(file.substring(info.dataDir.length), key)));
                                    if (promises.length)
                                        return Promise.all(promises);
                                });
                        },
                        dir => {
                            return Promise.resolve(path.basename(dir)[0] !== '.');
                        }
                    )
                    .then(() => {
                        return this._filer.remove(path.join(info.dataDir, filename))
                            .catch(() => {
                                // do nothing
                            });
                    });
            });
    }

    /**
     * Signal variable change
     * @param {string} variable                     Variable name
     * @return {Promise}
     */
    touch(variable) {
        return this.setAttr(variable, 'mtime', Math.round(Date.now() / 1000));
    }

    /**
     * Set attribute
     * @param {string} variable                     Variable name
     * @param {*} name                              Attribute name
     * @param {*} value                             Attribute value
     * @return {Promise}                            Resolves to history id
     */
    setAttr(variable, name, value) {
        this._logger.debug('directory', `Setting attribute ${name} of ${variable}`);

        return this.get(variable, false, false)
            .then(info => {
                if (!info)
                    info = {};

                if (this.isEqual(info[name], value))
                    return null;

                this._initAttrs(info);
                info[name] = value;
                return this.set(variable, info);
            });
    }

    /**
     * Get attribute
     * @param {string} variable                     Variable name
     * @param {string} name                         Attribute name
     * @return {Promise}
     */
    getAttr(variable, name) {
        this._logger.debug('directory', `Getting attribute ${name} of ${variable}`);

        return this.get(variable)
            .then(info => {
                if (!info)
                    return null;

                return typeof info[name] === 'undefined' ? null : info[name];
            });
    }

    /**
     * Delete attribute
     * @param {string} variable                     Variable name
     * @param {string} name                         Attribute name
     * @return {Promise}
     */
    delAttr(variable, name) {
        this._logger.debug('directory', `Deleting attribute ${name} of ${variable}`);

        return this.get(variable, false, false)
            .then(info => {
                if (!info || typeof info[name] === 'undefined')
                    return null;

                delete info[name];
                return this.set(variable, info);
            });
    }

    /**
     * Set history depth
     * @param {string} variable                     Variable name
     * @param {number|null} value                   History depth
     * @return {Promise}
     */
    setHDepth(variable, value) {
        if (!value)
            return this.delAttr(variable, 'hdepth');

        return this.setAttr(variable, 'hdepth', value)
            .then(id => {
                return Promise.resolve()
                    .then(() => {
                        if (!this._util.isUuid(variable))
                            return this.parseVariable(variable);

                        let search = this._index.search(this._index.constructor.binUuid(variable));
                        if (!search || search.type !== 'variable')
                            return [ null, null ];

                        return [ search.directory, search.path ];
                    })
                    .then(([ repo, filename ]) => {
                        if (!repo || !filename)
                            return id;

                        variable = `${repo}:${filename}`;
                        this._logger.debug('directory', `Applying hdepth of ${variable}`);

                        let info = this.directories.get(repo);
                        return this._filer.process(
                                path.join(info.dataDir, filename),
                                null,
                                dir => {
                                    if (path.basename(dir)[0] === '.')
                                        return Promise.resolve(false);

                                    dir = dir.substring(info.dataDir.length);

                                    return this.clearHistory(`${repo}:${dir}`, value);
                                }
                            )
                            .then(() => {
                                return this.clearHistory(`${repo}:${filename}`, value);
                            })
                            .then(() => {
                                return id;
                            });
                    });
            });
    }

    /**
     * Get history depth
     * @param {string} variable                     Variable name
     * @return {Promise}                            Resolves to history depth
     */
    getHDepth(variable) {
        let getDepth = variable => {
            return this.getAttr(variable, 'hdepth')
                .then(hdepth => {
                    if (hdepth !== null)
                        return hdepth;

                    return Promise.resolve()
                        .then(() => {
                            if (!this._util.isUuid(variable))
                                return this.parseVariable(variable);

                            let search = this._index.search(this._index.constructor.binUuid(variable));
                            if (!search)
                                return [ null, null ];

                            return [search.directory, search.path];
                        })
                        .then(([repo, filename]) => {
                            if (!repo || !filename || filename === '/')
                                return null;

                            let dir = path.dirname(filename);
                            return getDepth(`${repo}:${dir}`);
                        });
                });
        };
        return getDepth(variable);
    }

    /**
     * Add history record
     * @param {string} variable                     Variable name
     * @param {object} attrs                        Variable
     * @return {Promise}                            Resolves to id
     */
    addHistory(variable, attrs) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename)
                    return;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Adding to history of ${variable}`);

                let info = this.directories.get(repo);
                let now = new Date();
                let mtime = Math.round(now.getTime() / 1000);
                let directory = path.join(
                    info.dataDir,
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
                    variable: attrs,
                };

                let history;

                return this._filer.createDirectory(
                        directory,
                        { mode: info.dirMode, uid: info.uid, gid: info.gid }
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
                            numbers.sort((a, b) => { return a - b; });
                            name = this._padNumber(numbers[numbers.length - 1] + 1, 4);
                        } else {
                            name = '0001';
                        }
                        history = path.join(directory, name + '.json');

                        return this._filer.lockWrite(
                            history,
                            JSON.stringify(json, undefined, 4) + '\n',
                            { mode: info.fileMode, uid: info.uid, gid: info.gid }
                        );
                    })
                    .then(() => {
                        this._index.insert(
                            'history',
                            this._index.constructor.binUuid(json.id),
                            {
                                directory: repo,
                                path: filename,
                                attr: history.substring(info.dataDir.length),
                            }
                        );
                    })
                    .then(() => {
                        return this.getHDepth(variable);
                    })
                    .then(hdepth => {
                        if (hdepth !== null)
                            return this.clearHistory(variable, hdepth);
                    })
                    .then(() => {
                        return json.id;
                    });
            });
    }

    /**
     * Clear all the history
     * @param {string} variable                     Variable name
     * @param {number} [hdepth]                     History depth
     * @return {Promise}
     */
    clearHistory(variable, hdepth) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename)
                    return;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Clearing history of ${variable} (hdepth: ${hdepth})`);

                let info = this.directories.get(repo);
                let re = /^(\d+)\.json$/;
                let files = [], dirs = [];
                let baseDir = path.join(info.dataDir, filename, '.history');
                return this._filer.process(
                        baseDir,
                        file => {
                            if (!re.test(path.basename(file)))
                                return Promise.resolve();

                            return this._filer.lockRead(file)
                                .then(contents => {
                                    let json = JSON.parse(contents);
                                    files.push({ id: json.id, mtime: json.mtime, path: file });
                                });
                        },
                        dir => {
                            let name = dir.substring(baseDir.length);
                            return Promise.resolve(name.split('/').length <= 5);
                        }
                    )
                    .then(() => {
                        files.sort((a, b) => { return a.mtime - b.mtime; });
                        let promises = [];
                        for (let i = 0; i < (hdepth ? files.length - hdepth : files.length); i++) {
                            if (this._util.isUuid(files[i]['id']))
                                this._index.del(this._index.constructor.binUuid(files[i]['id']));
                            promises.push(this._filer.remove(files[i]['path']));

                            let dir = path.dirname(files[i]['path']);
                            if (path.basename(dir) !== '.history' && dirs.indexOf(dir) === -1)
                                dirs.push(dir);
                        }

                        if (promises.length)
                            return Promise.all(promises);
                    })
                    .then(() => {
                        let deleteEmpty = dirs => {
                            let todo = [];
                            return dirs.reduce(
                                    (prev, cur) => {
                                        return prev.then(() => {
                                            try {
                                                if (!fs.readdirSync(cur).length) {
                                                    let dir = path.dirname(cur);
                                                    if (path.basename(dir) !== '.history' && todo.indexOf(dir) === -1)
                                                        todo.push(dir);
                                                    return this._filer.remove(cur);
                                                }
                                            } catch (error) {
                                                // do nothing
                                            }
                                            return Promise.resolve();
                                        });
                                    },
                                    Promise.resolve()
                                )
                                .then(() => {
                                    if (todo.length)
                                        return deleteEmpty(todo);
                                })
                        };
                        return deleteEmpty(dirs);
                    });
            });
    }

    /**
     * Set files depth
     * @param {string} variable                     Variable name
     * @param {number|null} value                   Files depth
     * @return {Promise}
     */
    setFDepth(variable, value) {
        if (!value)
            return this.delAttr(variable, 'fdepth');

        return this.setAttr(variable, 'fdepth', value)
            .then(id => {
                return Promise.resolve()
                    .then(() => {
                        if (!this._util.isUuid(variable))
                            return this.parseVariable(variable);

                        let search = this._index.search(this._index.constructor.binUuid(variable));
                        if (!search || search.type !== 'variable')
                            return [ null, null ];

                        return [ search.directory, search.path ];
                    })
                    .then(([ repo, filename ]) => {
                        if (!repo || !filename)
                            return id;

                        variable = `${repo}:${filename}`;
                        this._logger.debug('directory', `Applying fdepth of ${variable}`);

                        let info = this.directories.get(repo);
                        return this._filer.process(
                                path.join(info.dataDir, filename),
                                null,
                                dir => {
                                    if (path.basename(dir)[0] === '.')
                                        return Promise.resolve(false);

                                    dir = dir.substring(info.dataDir.length);

                                    return this.clearFiles(`${repo}:${dir}`, value);
                                }
                            )
                            .then(() => {
                                return this.clearFiles(`${repo}:${filename}`, value);
                            })
                            .then(() => {
                                return id;
                            });
                    });
            });
    }

    /**
     * Get files depth
     * @param {string} variable                     Variable name
     * @return {Promise}                            Resolves to files depth
     */
    getFDepth(variable) {
        let getDepth = variable => {
            return this.getAttr(variable, 'fdepth')
                .then(fdepth => {
                    if (fdepth !== null)
                        return fdepth;

                    return Promise.resolve()
                        .then(() => {
                            if (!this._util.isUuid(variable))
                                return this.parseVariable(variable);

                            let search = this._index.search(this._index.constructor.binUuid(variable));
                            if (!search)
                                return [ null, null ];

                            return [ search.directory, search.path ]
                        })
                        .then(([ repo, filename ]) => {
                            if (!repo || !filename || filename === '/')
                                return null;

                            let dir = path.dirname(filename);
                            return getDepth(`${repo}:${dir}`);
                        });
                })
        };
        return getDepth(variable);
    }

    /**
     * Upload a file
     * @param {string} variable                     Variable name
     * @param {Buffer} buffer                       File
     * @param {string} [saveName]                   Set name of the file to this
     * @return {Promise}                            Resolves to id
     */
    uploadFile(variable, buffer, saveName) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename)
                    return;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Uploading to ${variable}`);

                let info = this.directories.get(repo);
                let now = new Date();
                let mtime = Math.round(now.getTime() / 1000);
                let directory = path.join(
                    info.dataDir,
                    filename,
                    '.files',
                    now.getUTCFullYear().toString(),
                    this._padNumber(now.getUTCMonth() + 1, 2),
                    this._padNumber(now.getUTCDate(), 2),
                    this._padNumber(now.getUTCHours(), 2)
                );

                let json = {
                    id: uuid.v4(),
                    mtime: mtime,
                    bin: null,
                };

                let attrfile, binfile;

                return this._filer.createDirectory(
                        directory,
                        { mode: info.dirMode, uid: info.uid, gid: info.gid }
                    )
                    .then(() => {
                        let name;
                        let files = fs.readdirSync(directory);
                        let numbers = [];
                        let reBin = /^(\d+)\.bin/, reJson = /^(\d+)\.json/;
                        for (let file of files) {
                            let result = reBin.exec(file);
                            if (!result)
                                result = reJson.exec(file);
                            if (!result)
                                continue;

                            let number = parseInt(result[1]);
                            if (numbers.indexOf(number) === -1)
                                numbers.push(number);
                        }
                        if (numbers.length) {
                            numbers.sort((a, b) => { return a - b; });
                            name = this._padNumber(numbers[numbers.length - 1] + 1, 4);
                        } else {
                            name = '0001';
                        }
                        attrfile = path.join(directory, name + '.json');
                        binfile = path.join(directory, name + '.bin');
                        json.bin = binfile.substring(info.dataDir.length);
                        if (saveName)
                            json.bin = path.join(json.bin, saveName);

                        return Promise.resolve()
                            .then(() => {
                                if (saveName) {
                                    return this._filer.createDirectory(
                                        binfile,
                                        { mode: info.dirMode, uid: info.uid, gid: info.gid }
                                    )
                                }
                            })
                            .then(() => {
                                return Promise.all([
                                    this._filer.lockWrite(
                                        attrfile,
                                        JSON.stringify(json, undefined, 4) + '\n',
                                        { mode: info.fileMode, uid: info.uid, gid: info.gid }
                                    ),
                                    this._filer.lockWriteBuffer(
                                        saveName ? path.join(binfile, saveName) : binfile,
                                        buffer,
                                        { mode: info.fileMode, uid: info.uid, gid: info.gid }
                                    ),
                                ]);
                            });
                    })
                    .then(() => {
                        this._index.insert(
                            'file',
                            this._index.constructor.binUuid(json.id),
                            {
                                directory: repo,
                                path: filename,
                                attr: attrfile.substring(info.dataDir.length),
                                bin: binfile.substring(info.dataDir.length),
                            }
                        );
                    })
                    .then(() => {
                        return this.getFDepth(variable);
                    })
                    .then(fdepth => {
                        if (fdepth !== null)
                            return this.clearFiles(variable, fdepth);
                    })
                    .then(() => {
                        return json.id;
                    });
            });
    }

    /**
     * Download a file
     * @param {string} variable                     Variable name
     * @return {Promise}                            Resolves Buffer
     */
    downloadFile(variable) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search)
                    return [ null, null ];

                if ([ 'variable', 'file' ].indexOf(search.type) === -1)
                    return [ null, null ];

                return [ search.directory, search.path, search.type, search.bin ];
            })
            .then(([ repo, filename, type, bin ]) => {
                if (!repo || !filename)
                    return null;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Downloading ${variable}`);

                let info = this.directories.get(repo);

                if (type === 'file')
                    return path.join(info.dataDir, bin);

                let loadDir = (dir, depth) => {
                    return new Promise((resolve, reject) => {
                        try {
                            let name;
                            let files = fs.readdirSync(dir);
                            let numbers = [];
                            let reJson = /^(\d+)\.json$/, reDir = /^(\d+)$/;
                            if (depth < 5) {
                                for (let file of files) {
                                    let result = reDir.exec(file);
                                    if (result) {
                                        numbers.push({
                                            num: parseInt(result[1]),
                                            str: result[1],
                                        });
                                    }
                                }
                                if (numbers.length) {
                                    numbers.sort((a, b) => { return a.num - b.num; });
                                    name = numbers[numbers.length - 1].str;
                                    loadDir(path.join(dir, name), depth + 1)
                                        .then(filename => {
                                            resolve(filename);
                                        })
                                        .catch(error => {
                                            this._logger.error(`FS error: ${error.message}`);
                                            resolve(null);
                                        });
                                } else {
                                    resolve(null);
                                }
                            } else if (depth === 5) {
                                for (let file of files) {
                                    let result = reJson.exec(file);
                                    if (result) {
                                        numbers.push({
                                            num: parseInt(result[1]),
                                            str: result[1],
                                        });
                                    }
                                }
                                if (numbers.length) {
                                    numbers.sort((a, b) => {
                                        return a.num - b.num;
                                    });
                                    resolve(path.join(dir, numbers[numbers.length - 1].str + '.json'));
                                } else {
                                    resolve(null);
                                }
                            } else {
                                resolve(null);
                            }
                        } catch (error) {
                            this._logger.error(`FS error: ${error.message}`);
                            resolve(null);
                        }
                    });
                };

                return loadDir(path.join(info.dataDir, filename, '.files'), 1)
                    .then(filename => {
                        if (!filename)
                            return null;

                        return this._filer.lockRead(filename)
                            .then(contents => {
                                let json = JSON.parse(contents);
                                return this._filer.lockReadBuffer(path.join(info.dataDir, json.bin));
                            });
                    });
            });
    }

    /**
     * Clear all uploaded files
     * @param {string} variable                     Variable name
     * @param {number} [fdepth]                     Files depth
     * @return {Promise}
     */
    clearFiles(variable, fdepth) {
        return Promise.resolve()
            .then(() => {
                if (!this._util.isUuid(variable))
                    return this.parseVariable(variable);

                let search = this._index.search(this._index.constructor.binUuid(variable));
                if (!search || search.type !== 'variable')
                    return [ null, null ];

                return [ search.directory, search.path ];
            })
            .then(([ repo, filename ]) => {
                if (!repo || !filename)
                    return;

                variable = `${repo}:${filename}`;
                this._logger.debug('directory', `Clearing files of ${variable} (fdepth: ${fdepth})`);

                let info = this.directories.get(repo);
                let re = /^(\d+)\.json$/;
                let files = [], dirs = [];
                let baseDir = path.join(info.dataDir, filename, '.files');
                return this._filer.process(
                        baseDir,
                        file => {
                            if (!re.test(path.basename(file)))
                                return Promise.resolve();

                            return this._filer.lockRead(file)
                                .then(contents => {
                                    let json = JSON.parse(contents);
                                    let bin = path.join(info.dataDir, json['bin']);
                                    let jsonDepth = file.split('/').length;
                                    let binDepth = bin.split('/').length;
                                    files.push({
                                        id: json.id,
                                        mtime: json.mtime,
                                        path: file,
                                        bin: (binDepth === jsonDepth + 1) ? path.dirname(bin) : bin
                                    });
                                });
                        },
                        dir => {
                            let name = dir.substring(baseDir.length);
                            return Promise.resolve(name.split('/').length <= 5);
                        }
                    )
                    .then(() => {
                        files.sort((a, b) => { return a.mtime - b.mtime; });
                        let promises = [];
                        for (let i = 0; i < (fdepth ? files.length - fdepth : files.length); i++) {
                            if (this._util.isUuid(files[i]['id']))
                                this._index.del(this._index.constructor.binUuid(files[i]['id']));

                            promises.push(
                                Promise.all([
                                    this._filer.remove(files[i]['path']),
                                    this._filer.remove(files[i]['bin']),
                                ])
                            );

                            let dir = path.dirname(files[i]['path']);
                            if (path.basename(dir) !== '.files' && dirs.indexOf(dir) === -1)
                                dirs.push(dir);
                        }

                        if (promises.length)
                            return Promise.all(promises);
                    })
                    .then(() => {
                        let deleteEmpty = dirs => {
                            let todo = [];
                            return dirs.reduce(
                                    (prev, cur) => {
                                        return prev.then(() => {
                                            try {
                                                if (!fs.readdirSync(cur).length) {
                                                    let dir = path.dirname(cur);
                                                    if (path.basename(dir) !== '.files' && todo.indexOf(dir) === -1)
                                                        todo.push(dir);
                                                    return this._filer.remove(cur);
                                                }
                                            } catch (error) {
                                                // do nothing
                                            }
                                            return Promise.resolve();
                                        });
                                    },
                                    Promise.resolve()
                                )
                                .then(() => {
                                    if (todo.length)
                                        return deleteEmpty(todo);
                                })
                        };
                        return deleteEmpty(dirs);
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
     * Initialize variable structure
     * @param {object} attrs
     * @return {object}
     */
    _initAttrs(attrs) {
        attrs.mtime = Math.round(Date.now() / 1000);
        if (!attrs.ctime)
            attrs.ctime = attrs.mtime;
        if (!attrs.id)
            attrs.id = uuid.v4();
        return attrs;
    }

    _startFolder(folder) {
        let info = this.directories.get(folder);
        return Promise.resolve()
            .then(() => {
                if (!info)
                    throw new Error(`Unknown folder ${folder}`);
                info.enabled = false;

                if (!info.group)
                    return;

                if (os.platform() === 'freebsd')
                    return this._runner.exec('pw', ['groupadd', info.group]);

                return this._runner.exec('groupadd', [info.group]);
            })
            .then(() => {
                if (!info.group || !this.syncUser)
                    return;

                if (os.platform() === 'freebsd')
                    return this._runner.exec('pw', ['groupmod', info.group, '-m', this.syncUser]);

                return this._runner.exec('usermod', ['-G', info.group, '-a', this.syncUser]);
            })
            .then(() => {
                return Promise.all([
                    this._runner.exec('grep', ['-E', `^${info.user}:`, '/etc/passwd']),
                    this._runner.exec('grep', ['-E', `^${info.group}:`, '/etc/group']),
                ]);
            })
            .then(([userInfo, groupInfo]) => {
                let userDb = userInfo.stdout.trim().split(':');
                if (userInfo.code !== 0 || userDb.length !== 7) {
                    this._logger.error(`Directory user ${info.user} not found`);
                    info.user = null;
                    info.uid = null;
                } else {
                    info.uid = parseInt(userDb[2]);
                }

                let groupDb = groupInfo.stdout.trim().split(':');
                if (groupInfo.code !== 0 || groupDb.length !== 4) {
                    this._logger.error(`Directory group ${info.group} not found`);
                    info.group = null;
                    info.gid = null;
                } else {
                    info.gid = parseInt(groupDb[2]);
                }

                return this._filer.createDirectory(
                    info.dataDir,
                    { mode: info.dirMode, uid: info.uid, gid: info.gid }
                )
            })
            .then(() => {
                if (!info.user || !info.group)
                    return;

                return this._runner.exec('chown', [ '-R', `${info.user}:${info.group}`, info.rootDir ])
                    .then(() => {
                        return this._runner.exec('chmod', [ '-R', 'ug+rwX', info.rootDir ]);
                    })
                    .then(() => {
                        info.enabled = true;
                    });
            });
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

    /**
     * Retrieve index server
     * @return {Index}
     */
    get _index() {
        if (this._index_instance)
            return this._index_instance;
        this._index_instance = this._app.get('servers').get('index');
        return this._index_instance;
    }
}

module.exports = Directory;
