/**
 * Directory data server
 * @module servers/directory
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
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
     * @param {Cacher} cacher               Cacher service
     */
    constructor(app, config, logger, filer, runner, cacher) {
        super();

        this.waiting = new Map();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
        this._runner = runner;
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
        return [ 'app', 'config', 'logger', 'filer', 'runner', 'cacher' ];
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

                if (user === '999' || group === '999') { // TODO: Remove this
                    user = bhdirConfig.directory.user = 'rslsync';
                    group = bhdirConfig.directory.group = 'rslsync';
                    fs.writeFileSync(path.join(configPath, 'bhdir.conf'), ini.stringify(bhdirConfig));
                }

                return Promise.all([
                        this._runner.exec('grep', [ '-E', `^${user}:`, '/etc/passwd' ]),
                        this._runner.exec('grep', [ '-E', `^${group}:`, '/etc/group' ]),
                    ])
                    .then(([ userInfo, groupInfo ]) => {
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
     * Wait for variable change
     * @param {string} filename                     Variable path
     * @param {number} timeout                      Timeout in ms, 0 for no timeout
     * @return {Promise}
     */
    wait(filename, timeout) {
        return this.get(filename)
            .then(result => {
                let info = this.waiting.get(filename);
                if (info && info.value !== result) {
                    this.notify(filename, result);
                    info = null;
                }
                if (!info) {
                    info = {
                        value: result,
                        handlers: new Set(),
                    };
                    this.waiting.set(filename, info);
                }

                return new Promise((resolve) => {
                    let cb = result => {
                        this._logger.debug('directory', `Wait on ${filename} timeout: ${result}`);
                        resolve(result);
                    };
                    info.handlers.add(cb);
                    if (timeout)
                        setTimeout(() => { cb(true); }, timeout);
                });
            })
            .catch(error => {
                this._logger.error(new WError(error, 'Directory.wait()'));
            });
    }

    /**
     * Signal variable change
     * @param {string} event                        'update' or 'delete'
     * @param {string} filename                     Variable path
     * @param {number} mtime                        Expected modification time
     * @return {Promise}
     */
    touch(event, filename, mtime) {
        let hash = crypto.createHash('sha256').update(filename).digest('hex');
        let json = {
            vars: [
                {
                    event: event,
                    path: filename,
                    mtime: mtime,
                }
            ],
        };
        return this._filer.lockWrite(
            path.join(this.updatesDir, hash + '.json'),
            JSON.stringify(json, undefined, 4) + '\n',
            { mode: this.fileMode, uid: this.user, gid: this.group }
        );
    }

    /**
     * Notify about variable change
     * @param {string} filename                     Variable path
     * @param {*} value                             Variable value
     */
    notify(filename, value) {
        let waiting = this.waiting.get(filename);
        if (!waiting || waiting.value === value)
            return;

        for (let cb of waiting.handlers)
            cb(false);
        this.waiting.delete(filename);
    }

    /**
     * Set variable
     * @param {string} filename                     Variable path
     * @param {*} value                             Variable value
     * @return {Promise}
     */
    set(filename, value) {
        this._logger.debug('directory', `Setting ${filename} to ${value}`);

        if (value === null) {
            this._logger.error(`Could not set ${filename} to null`);
            return Promise.resolve();
        }

        let parts = filename.split('/');
        let name = parts.pop();
        let directory = path.join(this.dataDir, parts.join('/'));

        return this.get(filename)
            .then(result => {
                if (result === value)
                    return;

                let varsFile = path.join(directory, '.vars.json');
                return this._cacher.set(filename, value)
                    .then(() => {
                        this.notify(filename, value);

                        return this._filer.createDirectory(
                            directory,
                            { mode: this.dirMode, uid: this.user, gid: this.group }
                        );
                    })
                    .then(() => {
                        return this._watcher.updateJson(
                            varsFile,
                            json => {
                                json[name] = value;
                                return json;
                            }
                        );
                    })
                    .then(() => {
                        let mtime = 0;
                        try {
                            let stats = fs.statSync(varsFile);
                            mtime = stats.mtime;
                        } catch (error) {
                            // do nothing
                        }
                        return this.touch('update', filename, mtime);
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

        let parts = filename.split('/');
        let name = parts.pop();
        let directory = path.join(this.dataDir, parts.join('/'));

        return this._cacher.get(filename)
            .then(result => {
                if (typeof result !== 'undefined')
                    return result;

                return this._watcher.readJson(path.join(directory, '.vars.json'))
                    .then(json => {
                        let result = typeof json[name] === 'undefined' ? null : json[name];

                        return this._cacher.set(filename, result)
                            .then(() => {
                                return result;
                            });
                    });
            });
    }

    /**
     * Delete variable
     * @param {string} filename                     Variable path
     * @return {Promise}
     */
    unset(filename) {
        this._logger.debug('directory', `Unsetting ${filename}`);

        let parts = filename.split('/');
        let name = parts.pop();
        let directory = path.join(this.dataDir, parts.join('/'));

        return this._cacher.unset(filename)
            .then(() => {
                this.notify(filename, null);

                return this._filer.createDirectory(
                    directory,
                    { mode: this.dirMode, uid: this.user, gid: this.group }
                );
            })
            .then(() => {
                return this._watcher.updateJson(
                    path.join(directory, '.vars.json'),
                    json => {
                        delete json[name];
                        return json;
                    }
                );
            })
            .then(() => {
                return this.touch('delete', filename, 0);
            });
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
