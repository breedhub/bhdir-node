/**
 * Directory data server
 * @module servers/directory
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
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
                let configPath = (os.platform() == 'freebsd' ? '/usr/local/etc/bhdir' : '/etc/bhdir');
                try {
                    fs.accessSync(path.join(configPath, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    throw new Error('Could not read bhdir.conf');
                }

                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configPath, 'bhdir.conf'), 'utf8'));
                let _rootDir = bhdirConfig.directory && bhdirConfig.directory.root;
                if (!_rootDir)
                    throw new Error('No root parameter in directory section of bhdir.conf');

                this._dataDir = path.join(_rootDir, 'data');
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
                        if (result === null || typeof result != 'object' || typeof result.then != 'function')
                            throw new Error(`Module '${curName}' register() did not return a Promise`);
                        return result;
                    });
                },
                Promise.resolve()
            )
            .then(() => {
                this._logger.debug('directory', 'Starting the server');
                let configPath = (os.platform() == 'freebsd' ? '/usr/local/etc/bhdir' : '/etc/bhdir');
                try {
                    fs.accessSync(path.join(configPath, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    throw new Error('Could not read bhdir.conf');
                }

                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configPath, 'bhdir.conf'), 'utf8'));
                this._dirMode = parseInt((bhdirConfig.directory && bhdirConfig.directory.dir_mode) || '750', 8);
                this._fileMode = parseInt((bhdirConfig.directory && bhdirConfig.directory.file_mode) || '640', 8);
                let user = (bhdirConfig.directory && bhdirConfig.directory.user) || 'root';
                let group = (bhdirConfig.directory && bhdirConfig.directory.group) || (os.platform() == 'freebsd' ? 'wheel' : 'root');

                return Promise.all([
                        this._runner.exec('getent', [ 'passwd', user ]),
                        this._runner.exec('getent', [ 'group', group ]),
                    ])
                    .then(([ userInfo, groupInfo ]) => {
                        if (user.length && parseInt(user).toString() == user) {
                            this._user = parseInt(user);
                        } else {
                            let userDb = userInfo.stdout.trim().split(':');
                            if (userInfo.code !== 0 || userDb.length != 7)
                                return this._logger.error('Directory user not found');
                            this._user = parseInt(userDb[2]);
                        }

                        if (group.length && parseInt(group).toString() == group) {
                            this._group = parseInt(group);
                        } else {
                            let groupDb = groupInfo.stdout.trim().split(':');
                            if (groupInfo.code !== 0 || groupDb.length != 4)
                                return this._logger.error('Directory group not found');
                            this._group = parseInt(groupDb[2]);
                        }
                    });
            });
    }

    /**
     * Set variable
     * @param {string} filename                     Variable path
     * @return {boolean}
     */
    validatePath(filename) {
        if (typeof filename != 'string')
            return false;

        return (
            filename.length &&
            filename[0] == '/' &&
            filename[filename.length - 1] != '/' &&
            filename.indexOf('/.') == -1
        );
    }

    /**
     * Set variable
     * @param {string} filename                     Variable path
     * @param {*} value                             Variable value
     * @return {Promise}
     */
    setVar(filename, value) {
        this._logger.debug('directory', `Setting ${filename} to ${value}`);

        let parts = filename.split('/');
        let name = parts.pop();
        let directory = path.join(this._dataDir, parts.join('/'));
        let notified = false;

        return this._cacher.set(filename, value)
            .then(reply => {
                if (typeof reply != 'undefined') {
                    this._watcher.notify(filename);
                    notified = true;
                }

                return this._filer.createDirectory(
                    directory,
                    { mode: this._dirMode, uid: this._user, gid: this._group }
                );
            })
            .then(() => {
                return this._filer.createFile(
                    path.join(directory, '.vars.json'),
                    { mode: this._fileMode, uid: this._user, gid: this._group }
                );
            })
            .then(() => {
                return this._filer.lockUpdate(
                        path.join(directory, '.vars.json'),
                        content => {
                            return new Promise((resolve, reject) => {
                                try {
                                    let json = {};
                                    if (content.trim().length)
                                        json = JSON.parse(content.trim());
                                    json[name] = value;
                                    resolve(JSON.stringify(json) + '\n');
                                } catch (error) {
                                    reject(error);
                                }
                            });
                        }
                    );
            })
            .then(() => {
                if (!notified)
                    this._watcher.notify(filename);

                return this._watcher.touch(filename);
            })
    }

    /**
     * Get variable
     * @param {string} filename                     Variable path
     * @return {Promise}
     */
    getVar(filename) {
        this._logger.debug('directory', `Getting ${filename}`);

        let parts = filename.split('/');
        let name = parts.pop();
        let directory = path.join(this._dataDir, parts.join('/'));

        return this._cacher.get(filename)
            .then(result => {
                if (typeof result != 'undefined')
                    return result;

                return this._filer.lockRead(path.join(directory, '.vars.json'))
                    .then(
                        content => {
                            if (content)
                                content = content.trim();
                            if (!content)
                                return null;

                            let json = JSON.parse(content);
                            return json[name] || null;
                        },
                        error => {
                            if (error.code == 'ENOENT')
                                return null;

                            throw error;
                        }
                    )
                    .then(result => {
                        return this._cacher.set(filename, result)
                            .then(() => {
                                return result;
                            });
                    });
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
