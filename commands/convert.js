/**
 * Convert command
 * @module commands/convert
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const ini = require('ini');
const uuid = require('uuid');
const argvParser = require('argv');
const SocketWrapper = require('socket-wrapper');

/**
 * Command class
 */
class Convert {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Filer} filer             Filer service
     */
    constructor(app, config, filer) {
        this._app = app;
        this._config = config;
        this._filer = filer;
    }

    /**
     * Service name is 'commands.convert'
     * @type {string}
     */
    static get provides() {
        return 'commands.convert';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'filer' ];
    }

    /**
     * Run the command
     * @param {string[]} argv           Arguments
     * @return {Promise}
     */
    run(argv) {
        let args = argvParser
            .option({
                name: 'help',
                short: 'h',
                type: 'boolean',
            })
            .option({
                name: 'data-dir',
                short: 'd',
                type: 'string',
            })
            .run(argv);

        this.dataDir = args.options['data-dir'] || '/var/lib/bhdir/sync/data';

        let upgrading = false;
        return this._filer.lockUpdate(
                path.join(this.dataDir, '.bhdir.json'),
                contents => {
                    try {
                        this.bhdirInfo = JSON.parse(contents);
                        if (typeof this.bhdirInfo !== 'object')
                            return Promise.reject(new Error('.bhdir.json is damaged'));
                    } catch (error) {
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
                        this.bhdirInfo.directory.upgrading = true;
                    }

                    return Promise.resolve(JSON.stringify(this.bhdirInfo, undefined, 4) + '\n');
                }
            )
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

                return upgradeDir(this.dataDir)
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
                    })
            })
            .then(() => {
                process.exit(0);
            })
            .catch(error => {
                return this.error(error.message);
            });
    }

    /**
     * Send request and return response
     * @param {Buffer} request
     * @param {string} [sockName]
     * @return {Promise}
     */
    send(request, sockName) {
        return new Promise((resolve, reject) => {
            let sock;
            if (sockName && sockName[0] === '/')
                sock = sockName;
            else
                sock = path.join('/var', 'run', this._config.project, this._config.instance + (sockName || '') + '.sock');

            let onError = error => {
                this.error(`Could not connect to daemon: ${error.message}`);
            };

            let socket = net.connect(sock, () => {
                this._app.debug('Connected to daemon');
                socket.removeListener('error', onError);
                socket.once('error', error => { this.error(error.message) });

                let wrapper = new SocketWrapper(socket);
                wrapper.on('receive', data => {
                    this._app.debug('Got daemon reply');
                    resolve(data);
                    socket.end();
                });
                wrapper.send(request);
            });
            socket.on('error', onError);
        });
    }

    /**
     * Log error and terminate
     * @param {...*} args
     */
    error(...args) {
        return this._app.error(...args)
            .then(
                () => {
                    process.exit(1);
                },
                () => {
                    process.exit(1);
                }
            );
    }
}

module.exports = Convert;