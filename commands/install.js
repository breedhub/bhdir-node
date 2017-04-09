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
     * @param {Syncthing} syncthing     syncthing server
     */
    constructor(app, config, runner, syncthing) {
        this._app = app;
        this._config = config;
        this._runner = runner;
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
        return [ 'app', 'config', 'runner', 'servers.syncthing' ];
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
                    fs.accessSync('/var/lib/bhdir/.syncthing', fs.constants.F_OK);
                } catch (error) {
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
                                    "STNODEFAULTFOLDER": "1",
                                    "HOME": '/var/lib/bhdir/.syncthing',
                                }
                            }
                        )
                        .then(result => {
                            if (result.code !== 0)
                                throw new Error('Could not init Syncthing');
                        });
                }
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