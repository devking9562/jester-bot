const sql = require('mssql');

class Database {
     config = {};
     poolConnection = null;
     connected = false;

     constructor(_config) {
          this.config = _config;
     }

     async connect() {
          if (this.connected == false) {
               this.poolConnection = await sql.connect(this.config);
               this.connected = true;
               console.log("DB connected!");
               await this.initTables();
          }
          else {
               console.log("DB already connected");
          }
     }

     // initializing bots 
     async initializeBots() {
          if (this.connected) {
               try {
                    const bots = [
                         { name: "🐕 BonkBot", simpleName: 'bonkbot', command: "bonkbot_bot&start=" },
                         { name: "☀️ FluxBot", simpleName: 'fluxbot', command: "fluxbeam_bot&start=" },
                         { name: '🦄 Unibot', simpleName: 'unibot', command: 'unibotsniper_bot&start=' },
                         { name: '🍌 Banana', simpleName: 'banana', command: 'BananaGunSniper_bot?start=snp_JesterBot_' },
                         { name: '🎩 Maestro', simpleName: 'maestro', command: 'MaestroSniperBot?start=' },
                         { name: '🎩 Maestro Pro', simpleName: 'maestropro', command: 'MaestroProBot?start=' },
                         { name: '🪲 Scarab', simpleName: 'scarab', command: 'scarab_tools_bot&start=' },
                         { name: '🥷 Shuriken', simpleName: 'shuriken', command: 'ShurikenTradeBot&start=qt-jester-' }
                    ];
                    bots.map(async (bot) =>
                         await this.poolConnection.request().query(`INSERT INTO bots (name, simpleName, command) VALUES (N'${bot.name}', '${bot.simpleName}', '${bot.command}')`)
                    )
               }
               catch (err) {
                    console.error(err);
               }
          }
     }

     async initializeFeeds() {
          if (this.connected) {
               try {
                    const feeds = [
                         { name: "eth", display: "Ξ MAINNET", chart: '<a href="https://www.dextools.io/app/en/ether/pair-explorer/${signalInfo.contractAddress}">DEXT</a> | <a href="https://dexscreener.com/ethereum/${signalInfo.contractAddress}">DEXS</a> | <a href="https://www.dexview.com/eth/${signalInfo.contractAddress}">DEXV</a>' },
                         { name: "sol", display: "🐕 SOL", chart: '<a href="https://www.dextools.io/app/en/solana/pair-explorer/${signalInfo.contractAddress}">DEXT</a> | <a href="https://dexscreener.com/solana/${signalInfo.contractAddress}">DEXS</a> | <a href="https://www.dexview.com/sol/${signalInfo.contractAddress}">DEXV</a>' },
                         { name: "axe", display: "🪓 AXE", chart: '<a href="https://www.tradingview.com/chart/?symbol=BINANCE%3A${signalInfo.contractAddress}%2USDT.P">TradingView</a>' }

                    ];
                    feeds.map(async (feed) =>
                         await this.poolConnection.request().query(`INSERT INTO feeds (feed_name, display_name, chart) VALUES (N'${feed.name}', N'${feed.display}', '${feed.chart}')`)
                    )
               }
               catch (err) {
                    console.error(err);
               }
          }
     }

     async initTables() {
          if (this.connected) {
               console.log("initalizating...");
               try {
                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='referrals' and xtype='U')
                         CREATE TABLE referrals(
                              id INT IDENTITY(1,1) PRIMARY KEY,
                              chatId NVARCHAR(270) NOT NULL UNIQUE,
                              followers NVARCHAR(270),
                         )
                    `);

                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='bots' and xtype='U')
                         CREATE TABLE bots (
                              id INT IDENTITY(1,1) PRIMARY KEY,
                              name NVARCHAR(270) NOT NULL,
                              simpleName NVARCHAR(270) NOT NULL UNIQUE,
                              command NVARCHAR(270) NOT NULL,
                              support NVARCHAR(270)
                         )
                    `);

                    //await this.initializeBots();

                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='feeds' and xtype='U')
                         CREATE TABLE feeds(
                              feed_name NVARCHAR(270) UNIQUE,
                              display_name NVARCHAR(270),
                              chart NVARCHAR(270),
                              scanner NVARCHAR(270),
                         )
                    `);

                    //await this.initializeFeeds();

                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='user_verification' and xtype='U')
                         CREATE TABLE user_verification(
                              chat_id NVARCHAR(270),
                              tradingId NVARCHAR(270),
                              wallet_address NVARCHAR(270) UNIQUE,
                              tier NVARCHAR(270),
                              verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                              referId NVARCHAR(270),
                              x_handle NVARCHAR(270),
                              agreedToTerms BIT DEFAULT 0,
                              post_url NVARCHAR(270),
                              trial NVARCHAR(270),
                         )
                    `);

                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='contract_requests' and xtype='U')
                         CREATE TABLE contract_requests(
                              id INT IDENTITY(1,1) PRIMARY KEY,
                              chat_id NVARCHAR(270) NOT NULL,
                              contract_address NVARCHAR(270) NOT NULL,
                              times_requested INT DEFAULT 1,
                              first_requested_by NVARCHAR(270),
                              requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
                         )
                    `);


                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='subscriptions' and xtype='U')
                         CREATE TABLE subscriptions (
                              id INT IDENTITY(1,1) PRIMARY KEY,
                              chat_id NVARCHAR(270) NOT NULL,
                              feed_name NVARCHAR(270) NOT NULL,
                              preferred_bot NVARCHAR(270),
                              subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                              CONSTRAINT uc_subscriptions UNIQUE (chat_id, feed_name)
                         )
                    `);

                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='signal_history' and xtype='U')
                         CREATE TABLE signal_history (
                              id INT IDENTITY(1,1) PRIMARY KEY,
                              name NVARCHAR(270),
                              contract_address NVARCHAR(270),
                              price FLOAT,
                              time DATETIME,
                              bias NVARCHAR(270)
                         )
                    `);

                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='feed_assets' and xtype='U')
                         CREATE TABLE feed_assets (
                              id INT IDENTITY(1,1) PRIMARY KEY,
                              name NVARCHAR(270),
                              contract_address NVARCHAR(270),
                              feed NVARCHAR(270),
                              alert BIT DEFAULT 0,
                         )
                    `);

                    await this.poolConnection.request().query(`
                         IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='user_assets' and xtype='U')
                         CREATE TABLE user_assets (
                              id INT IDENTITY(1,1) PRIMARY KEY,
                              chatId NVARCHAR(270),
                              assets NVARCHAR(270),
                              feed NVARCHAR(270),
                              alert BIT DEFAULT 0,
                         )
                    `);
                    console.log('Tables initialized successfully.');
               }
               catch (error) { }
          }
          else {
               console.log("DB not connected");
          }
     }

     async all(query, callback) {
          try {
               const res = await this.poolConnection.request().query(query);
               callback(null, res);
          }
          catch (err) {
               callback(err, null);
          }
     }
     async run(query, callback = null) {
          try {
               const res = await this.poolConnection.request().query(query);
               callback(null);
          }
          catch (err) {
               callback(err);
          }
     }
}
module.exports = Database;