/**
 * Installation specific application configuration
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');

let userConfig;
try {
    userConfig = ini.parse(fs.readFileSync(os.platform() == 'freebsd' ? '/usr/local/etc/bhdir/bhdir.conf' : '/etc/bhdir/bhdir.conf', 'utf8'));
} catch (error) {
    userConfig = {};
}

module.exports = {
    // Server instance name (alphanumeric)
    instance: 'daemon',

    // Environment
    env: process.env.NODE_ENV || 'production',

    // Loaded modules
    modules: [
        'daemon'
    ],

    // Servers
    servers: {
        daemon: {
            class: 'servers.daemon',
        },
        directory: {
            class: 'servers.directory',
        },
        watcher: {
            class: 'servers.watcher',
        },
    },

    // Redis servers
    redis: {
        main: {
            host: userConfig.redis && userConfig.redis.host,
            port: userConfig.redis && userConfig.redis.port,
            password: userConfig.redis && userConfig.redis.password,
        },
    },

    // SMTP servers
    smtp: {
        main: {
            host: 'localhost',
            port: 25,
            ssl: false,
            //user: 'username',
            //password: 'password',
        },
    },

    email: {
        from: 'root@localhost',
        logger: {
            info_enabled: false,            // email logger.info() or not
            warn_enabled: false,            // email logger.warn() or not
            error_enabled: false,           // email logger.error() or not
            to: 'debug@example.com',
        },
        daemon: {
            enabled: false,                 // email program crash or not
            to: 'debug@example.com',
        },
    },

    cache: {
        enable: true,
        redis: 'main',                      // Name of Redis configuration to use
        expire_min: parseInt((userConfig.directory && userConfig.directory.cache_ttl) || 500),
        expire_max: parseInt((userConfig.directory && userConfig.directory.cache_ttl) || 500),
    },

    logs: {
        main: {
            level: (userConfig.daemon && userConfig.daemon.log_level) || 'info',
            default: true,
            name: 'bhdir.log',
            path: '/var/log/bhdir',
            interval: '1d',
            mode: 0o640,
        },
    },

/*
    user: { // Drop privileges, otherwise comment out this section
        uid: 'www',
        gid: 'www',
    },
*/
};