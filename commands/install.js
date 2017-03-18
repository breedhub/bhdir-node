/**
 * Install command
 * @module commands/install
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Command class
 */
class Install {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Runner} runner           Runner service
     */
    constructor(app, config, runner) {
        this._app = app;
        this._config = config;
        this._runner = runner;
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
        return [ 'app', 'config', 'runner' ];
    }

    /**
     * Run the command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    run(argv) {
        return this.install()
            .then(() => {
                process.exit(0);
            })
            .catch(error => {
                return this.error(error.message);
            });
    }

    install() {
        return Promise.resolve()
            .then(() => {
                let configDir;
                if (os.platform() == 'freebsd') {
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
                        config = config.replace(/GROUP/g, os.platform() == 'freebsd' ? 'wheel' : 'root');
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
            })
    }

    /**
     * Log error and terminate
     * @param {...*} args
     */
    error(...args) {
        if (args.length)
            args[args.length - 1] = args[args.length - 1] + '\n';

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