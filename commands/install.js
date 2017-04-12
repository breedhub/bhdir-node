/**
 * Install command
 * @module commands/install
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const ini = require('ini');
const uuid = require('uuid');
const argvParser = require('argv');
const convert = require('xml-js');
const SocketWrapper = require('socket-wrapper');

/**
 * Command class
 */
class Install {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Runner} runner           Runner service
     * @param {Filer} filer             Filer service
     * @param {Util} util               Util service
     * @param {Syncthing} syncthing     syncthing server
     */
    constructor(app, config, runner, filer, util, syncthing) {
        this._app = app;
        this._config = config;
        this._runner = runner;
        this._filer = filer;
        this._util = util;
        this._syncthing = syncthing;
    }

    /**
     * Service name is 'commands.install'
     * @type {string}
     */
    static get provides() {
        return 'commands.install';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'runner', 'filer', 'util', 'servers.syncthing' ];
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
            .run(argv);

        return this.install()
            .then(() => {
                process.exit(0);
            })
            .catch(error => {
                return this.error(error.message);
            });
    }

    /**
     * Install bhdir
     * @return {Promise}
     */
    install() {
        return this._syncthing.constructor.getMainBinary()
            .then(syncthing => {
                if (!syncthing)
                    throw new Error('Unsupported platform');

                let configDir;
                if (os.platform() === 'freebsd') {
                    configDir = '/usr/local/etc/bhdir';
                    this._app.debug(`Platform: FreeBSD`);
                } else {
                    configDir = '/etc/bhdir';
                    this._app.debug(`Platform: Linux`);
                }

                try {
                    fs.accessSync(configDir, fs.constants.F_OK);
                } catch (error) {
                    try {
                        fs.mkdirSync(configDir, 0o750);
                    } catch (error) {
                        return this.error(`Could not create ${configDir}`);
                    }
                }
                try {
                    fs.accessSync('/var/run/bhdir', fs.constants.F_OK);
                } catch (error) {
                    try {
                        fs.mkdirSync('/var/run/bhdir', 0o755);
                    } catch (error) {
                        return this.error(`Could not create /var/run/bhdir`);
                    }
                }
                try {
                    fs.accessSync('/var/log/bhdir', fs.constants.F_OK);
                } catch (error) {
                    try {
                        fs.mkdirSync('/var/log/bhdir', 0o755);
                    } catch (error) {
                        return this.error(`Could not create /var/log/bhdir`);
                    }
                }
                try {
                    fs.accessSync('/var/lib/bhdir', fs.constants.F_OK);
                } catch (error) {
                    try {
                        fs.mkdirSync('/var/lib/bhdir', 0o755);
                    } catch (error) {
                        return this.error(`Could not create /var/lib/bhdir`);
                    }
                }

                try {
                    this._app.debug('Creating default config');
                    fs.accessSync(path.join(configDir, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    try {
                        let config = fs.readFileSync(path.join(__dirname, '..', 'bhdir.conf'), { encoding: 'utf8'});
                        config = config.replace(/GROUP/g, os.platform() === 'freebsd' ? 'wheel' : 'root');
                        fs.writeFileSync(path.join(configDir, 'bhdir.conf'), config, { mode: 0o640 });
                    } catch (error) {
                        console.log(error);
                        return this.error(`Could not create bhdir.conf`);
                    }
                }
                try {
                    fs.accessSync('/etc/systemd/system', fs.constants.F_OK);
                    this._app.debug('Creating systemd service');
                    let service = fs.readFileSync(path.join(__dirname, '..', 'systemd.service'), {encoding: 'utf8'});
                    fs.writeFileSync('/etc/systemd/system/bhdir.service', service, {mode: 0o644});
                } catch (error) {
                    // do nothing
                }
                try {
                    fs.accessSync('/etc/init.d', fs.constants.F_OK);
                    this._app.debug('Creating sysvinit service');
                    let service = fs.readFileSync(path.join(__dirname, '..', 'sysvinit.service'), {encoding: 'utf8'});
                    fs.writeFileSync('/etc/init.d/bhdir', service, {mode: 0o755});
                } catch (error) {
                    // do nothing
                }

                try {
                    fs.accessSync('/var/lib/bhdir/.config', fs.constants.F_OK);
                    return;
                } catch (error) {
                    // do nothing
                }

                try {
                    fs.mkdirSync('/var/lib/bhdir/.config', 0o700);
                } catch (error) {
                    return this.error(`Could not create /var/lib/bhdir/.config`);
                }

                let deviceId, deviceName;

                return this._filer.remove('/var/lib/bhdir/.syncthing')
                    .then(() => {
                        return this._runner.exec(
                            syncthing,
                            [
                                '-generate=/var/lib/bhdir/.syncthing',
                            ],
                            {
                                env: {
                                    "LANGUAGE": "C.UTF-8",
                                    "LANG": "C.UTF-8",
                                    "LC_ALL": "C.UTF-8",
                                    "PATH": "/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin",
                                    "HOME": '/var/lib/bhdir/.syncthing',
                                    "STNODEFAULTFOLDER": "1",
                                }
                            }
                        )
                    })
                    .then(result => {
                        if (result.code !== 0)
                            throw new Error('Could not init Syncthing');

                        return this._filer.lockUpdate(
                            '/var/lib/bhdir/.syncthing/config.xml',
                            contents => {
                                let st = convert.xml2js(contents, {compact: true});

                                Object.assign(
                                    st.configuration.gui,
                                    {
                                        address: {
                                            _text: this._syncthing.constructor.apiAddress + ':' + this._syncthing.constructor.apiPort,
                                        },
                                        apikey: {
                                            _text: this._util.getRandomString(32, {
                                                lower: true,
                                                upper: true,
                                                digits: true,
                                                special: false
                                            }),
                                        },
                                        user: {
                                            _text: 'bhdir',
                                        },
                                        password: {
                                            _text: this._util.encryptPassword('bhdir'),
                                        },
                                        theme: {
                                            _text: 'default',
                                        },
                                    }
                                );

                                Object.assign(
                                    st.configuration.options,
                                    {
                                        listenAddress: {
                                            _text: 'tcp://' + this._syncthing.constructor.mainAddress + ':' + this._syncthing.constructor.mainPort,
                                        },
                                        globalAnnounceEnabled: {
                                            _text: 'false',
                                        },
                                        localAnnouncePort: {
                                            _text: this._syncthing.constructor.announcePort,
                                        },
                                        localAnnounceMCAddr: {
                                            _text: this._syncthing.constructor.announceMCAddress,
                                        },
                                        relaysEnabled: {
                                            _text: 'false',
                                        },
                                        natEnabled: {
                                            _text: 'false',
                                        },
                                        startBrowser: {
                                            _text: 'false',
                                        },
                                        autoUpgradeIntervalH: {
                                            _text: '0',
                                        },
                                    }
                                );

                                deviceId = st.configuration.device._attributes.id;
                                deviceName = st.configuration.device._attributes.name;
                                return Promise.resolve(convert.js2xml(st, {compact: true, spaces: 4}));
                            }
                        );
                    })
                    .then(() => {
                        return this._filer.lockUpdate(
                            '/var/lib/bhdir/.config/node.json',
                            contents => {
                                let json;
                                try {
                                    json = JSON.parse(contents);
                                } catch (error) {
                                    json = {};
                                }

                                json.device = {
                                    id: deviceId,
                                    name: deviceName,
                                };

                                return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                            }
                        );
                    })
                    .then(() => {
                        return this._filer.lockUpdate(
                            '/var/lib/bhdir/.config/home.json',
                            contents => {
                                let json;
                                try {
                                    json = JSON.parse(contents);
                                } catch (error) {
                                    json = {};
                                }

                                json.name = 'bhdir';
                                json.devices = [
                                    {
                                        id: deviceId,
                                        name: deviceName,
                                        roles: [],
                                    }
                                ];

                                return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                            }
                        );
                    });
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

module.exports = Install;