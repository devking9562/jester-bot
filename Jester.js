const { Alchemy, Network } = require('alchemy-sdk');
const TelegramBot = require('node-telegram-bot-api');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const Database = require('./db/Database.js');
const { dbConfig } = require("./const.js");
const { TwitterApi } = require('twitter-api-v2')
const { create } = require('@hapi/joi/lib/ref.js');
const path = require('path');

const fs = require("fs");

require('dotenv').config();

const twitterAPI = new TwitterApi({
  appKey: process.env.CONSUMER_API_KEY,
  appSecret: process.env.CONSUMER_API_KEY_SECRET,
  accessToken: process.env.ACCESS_TOKEN,
  accessSecret: process.env.ACCESS_TOKEN_SECRET,
})
const roClient = twitterAPI.readOnly

const db = new Database(dbConfig);

db.connect();

const imagePathStart = path.join(__dirname, 'img', 'background.png'); // Adjust the path accordingly
const imagePathTrial = path.join(__dirname, 'img', 'free_trial.png'); // Adjust the path accordingly

const settings = {
  apiKey: process.env.ALCHEMY_API_KEY,
  network: (process.env.mode == "production" ? Network.ETH_MAINNET : Network.ETH_SEPOLIA),
  // network: Network.ETH_GOERLI,
};
console.log(settings);
const DECIMAL = (process.env.mode == "production" ? 9 : 18); // for mainnet
// const DECIMAL = 18; // for test network

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(botToken, { polling: true });
const alchemy = new Alchemy(settings);
const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // 100 messages per time frame
});


//set telegram bot menu
bot.setMyCommands([
  { command: 'menu', description: '🏠 Main Menu - View all options' },
  { command: 'request', description: '🔍 Request - Ask for a new token' },
  { command: 'verify', description: '✅ Verify - Verify your account' },
  { command: 'docs', description: '📖 Docs - Read the documentation' },
  { command: 'socials', description: '👥 Socials - Join our community' },
]);

let awaitingWalletChange = new Map();
let awaitingXAccount = new Map();
let awaitingPostUrl = new Map();
let awaitingPostTweet = new Map();
//token tier amounts
const tierMinimumBalances = {
  'Starter': '2500',
  'Standard': '5000',
  'Premium': '10000'
};
const tierThresholds = tierMinimumBalances;

// const tokenContractABI = [
//   {
//     "constant": true,
//     "inputs": [{ "name": "_owner", "type": "address" }],
//     "name": "balanceOf",
//     "outputs": [{ "name": "balance", "type": "uint256" }],
//     "type": "function"
//   }
// ];

const rateLimitMap = new Map();

function isRateLimited(userId) {
  const currentTime = Date.now();
  const timeWindow = 15 * 60 * 1000; // 15 minutes in milliseconds
  const maxRequests = 100;

  const userRequests = rateLimitMap.get(userId) || [];
  // Filter out requests outside the current time window
  const recentRequests = userRequests.filter(time => currentTime - time < timeWindow);

  if (recentRequests.length >= maxRequests) {
    return true; // User has exceeded the rate limit
  }

  // Update the user's requests list
  recentRequests.push(currentTime);
  rateLimitMap.set(userId, recentRequests);
  return false; // User has not exceeded the rate limit
}

async function getTwitterAccountCreationTime(screenName) {
  console.log(screenName);
  try {
    const data = await roClient.v2.userByUsername(screenName, {
      expansions: ['pinned_tweet_id'],
      'tweet.fields': ['lang'],
      'user.fields': ['username', 'created_at'],
    })
    console.log(screenName, data.data);
    const createdAt = new Date(data.data.created_at);

    console.log(`The account @${screenName} was created on: ${createdAt}`);
    return createdAt;
  }
  catch (error) {
    const createdAt = new Date();
    console.log(error);
    return createdAt;
  }
}

async function retrieveBots() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM bots", (err, rows) => {
      if (err) {
        console.error("Error retrieving bots:", err);
        reject(err);
      } else {
        console.log("Retrieved bots:", rows);
        resolve(rows.recordset);
      }
    });
  });
}

async function retrieveAssets(feedName) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM feed_assets WHERE feed LIKE '%${feedName}%' ORDER BY name ASC;`, (err, rows) => {
      if (err) {
        console.error("Error retrieving assets:", err);
        reject(err);
      } else {
        console.log("Retrieved assets:", rows);
        resolve(rows.recordset);
      }
    });
  });
}

let awaitingVerification = new Map();
let awaitingNewWallet = new Map();
let awaitingContractAddress = new Map();
let txHashMap = new Map();
let awaitingAction = new Map();

bot.onText(/\/start\s*(.+)?/, async (msg, match) => {
  const startParam = match[1];
  const chatId = msg.chat.id;
  console.log(startParam);
  if (startParam)
    await loginWithRef(startParam, chatId);
  clearAwaitingValues(chatId);

  const welcomeMessage = `
🃏 *Welcome to JesterBot* 🃏


*To get started:*
- ✅ Agree to our Terms and Conditions and begin receiving alerts via /verify
- 🐦 Access a free trial using X via /trial
- 🔖 Discover our various membership levels via /tiers
- 📚 Delve into detailed documentation via /docs
- 👥 Join the conversation on our social channels via /socials`;

  const opts = {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Verify', callback_data: 'verify' }],
        [{ text: '🐦 Trial', callback_data: 'trial' }],
        [{ text: '🤝 Referrals', callback_data: 'referrals' }],
        [{ text: '🔖 Membership Tiers', callback_data: 'tiers' }],
        [{ text: '📚 Documentation', callback_data: 'docs' }],
        [{ text: '👥 Social Channels', callback_data: 'socials' }],
      ]
    }
  };

  const imageStream = fs.createReadStream(imagePathStart);
  bot.sendPhoto(chatId, imageStream, {
    caption: welcomeMessage,
    parse_mode: 'Markdown',
    reply_markup: opts.reply_markup
  });

  //bot.sendMessage(chatId, welcomeMessage, opts);
});

//buy more jest prompt
function sendUpgradePrompt(chatId) {
  const message = "For access to more features, upgrade to a higher tier.";
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Verification Failed: Buy more $JEST', url: 'https://app.uniswap.org/swap?outputCurrency=0x6982508145454ce325ddbe47a25d4ec3d2311933' }]
      ]
    }
  };
  bot.sendMessage(chatId, message, options);
}

//VERIFICATION

/// Function to get the sender's address from a transaction hash
async function getSenderAddressFromTxHash(transactionHash, chatId) {
  console.log(transactionHash);
  try {
    const transactionDetails = await alchemy.core.getTransaction(transactionHash);
    console.log(transactionDetails);
    if (!transactionDetails) {
      await bot.sendMessage(chatId, "Could not find the transaction. Please ensure the transaction hash is correct and try again.")
        .catch(error => console.error(`Failed to send message: ${error.message}`));
      return null;
    }
    return transactionDetails.from;
  } catch (error) {
    console.error(`Error processing the transaction hash for chatId ${chatId}: ${error.message}`);
    await bot.sendMessage(chatId, "There was an error processing the transaction hash. Please try again.")
      .catch(error => console.error(`Failed to send message: ${error.message}`));
  }
  return null;
}

// Function to fetch the contract addresses requested by the user
function getUserRequests(chatId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT contract_address FROM contract_requests WHERE chat_id = '${chatId}'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching user requests: ${err.message}`);
        reject(err);
      } else {
        const addresses = rows.recordset.map(row => row.contract_address);
        resolve(addresses);
      }
    });
  });
}

// Function to verify posting current tweet for trial.

async function verifyWithTweet(x_handle, userId) {
  const chatId = await getChatIdFromTweeterName(x_handle);
  if (!userId) {
    userId = await generateIDCode(chatId);
  }
  console.log(x_handle, chatId);
  const refID = `https://t.me/JesterAlphaBot?start=${userId}`
  const ogURL = 'https://x.com/JestTech/status/1798041138496209220'
  const tweetText = encodeURIComponent(`🃏 Excited to start my free trial with @JestTech! Ready to explore cutting-edge trading solutions. ${refID} ${ogURL}🃏 #AlgoTrading #Crypto $JEST #JesterBot #TradingBot #TelegramBot`);
  const tweetUrl = `https://twitter.com/intent/tweet?text=${tweetText}`;

  await bot.sendMessage(chatId, `Please use the Post tweet button below to share your free trial.\n\nAfter you have posted, please copy the URL and use Register.`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [ //update before production
        [
          { text: "1.  Post", url: tweetUrl },
          { text: '2.  Register', callback_data: 'register_twitt_ID' },
        ]
      ]
    }
  });
}

// Insert a user into the database with the current timestamp
function insertUser(chatId, walletAddress, tier) {
  walletAddress = validator.escape(walletAddress);
  tier = validator.escape(tier);

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO user_verification (chat_id, wallet_address, tier) VALUES ('${chatId}', '${walletAddress}', '${tier}')`,
      function (err) {
        if (err) {
          console.error(`Error when inserting user: ${err.message}`);
          reject(err);
        } else {
          console.log(`A row has been inserted with rowid ${this.lastID}`);
          resolve(this.lastID); // Resolving with the ID of the new row.
        }
      });
  });
}

function insertContractRequest(chatId, contractAddress) {
  return new Promise((resolve, reject) => {
    // First, check if this user has already requested this contract address
    db.all(`SELECT id FROM contract_requests WHERE chat_id = '${chatId}' AND contract_address = '${contractAddress}'`, (err, row) => {
      if (err) {
        console.error(`Error when checking for existing request: ${err.message}`);
        reject(err);
      } else if (row && row.recordset[0]) {
        // The user has already requested this contract address
        resolve({ alreadyRequested: true, requestId: row.recordset[0].id });
      } else {
        // Check if the contract address has already been requested by any user
        db.all(`SELECT id, times_requested FROM contract_requests WHERE contract_address = '${contractAddress}'`, (err, row) => {
          if (err) {
            console.error(`Error when checking existing contract request: ${err.message}`);
            reject(err);
          } else if (row && row.recordset[0]) {
            // The contract address has been requested by someone else, increment the times_requested
            db.run(`UPDATE contract_requests SET times_requested = times_requested + 1 WHERE id = '${row.recordset[0].id}'`, (updateErr) => {
              if (updateErr) {
                console.error(`Error when updating contract request: ${updateErr.message}`);
                reject(updateErr);
              } else {
                resolve({ alreadyRequested: false, requestId: row.recordset[0].id });
              }
            });
          } else {
            // This is a new contract address request, insert it
            db.run(
              `INSERT INTO contract_requests (chat_id, contract_address, first_requested_by) VALUES ('${chatId}', '${contractAddress}', '${chatId}')`,
              function (insertErr) {
                if (insertErr) {
                  console.error(`Error when inserting new contract request: ${insertErr.message}`);
                  reject(insertErr);
                } else {
                  resolve({ alreadyRequested: false, requestId: this.lastID });
                }
              });
          }
        });
      }
    });
  });
}

// Function to determine the user's tier based on their token balance
async function determineUserTier(transactionHash, chatId, _balance = 0) {
  const senderAddress = await getSenderAddressFromTxHash(transactionHash, chatId);
  if (!senderAddress) return; // Exit if senderAddress could not be retrieved

  const contractAddress = process.env.CONTRACT_ADDRESS;
  const tokenDecimals = DECIMAL; // Replace with your token's actual decimals

  try {
    // Fetching the token balances using Alchemy
    const balances = await alchemy.core.getTokenBalances(senderAddress, [contractAddress]);
    // Log the full API response for debugging
    console.log(`Token Balances for ${senderAddress}:`, JSON.stringify(balances, null, 2));
    console.log(_balance);
    const tokenBalanceData = balances.tokenBalances.find(token => token.contractAddress.toLowerCase() === contractAddress.toLowerCase());

    // if (!tokenBalanceData || tokenBalanceData.tokenBalance === '0') {
    //   await bot.sendMessage(chatId, "Your token balance is zero or could not be retrieved. Please ensure you have the tokens and try again.");
    //   return null;
    // }

    // Convert the token balance from hexadecimal to decimal and adjust for decimals
    const balanceBigInt = BigInt(tokenBalanceData.tokenBalance);
    let adjustedBalance = Number(balanceBigInt) / Math.pow(10, tokenDecimals);
    if (_balance != -1) adjustedBalance += _balance;
    // Determine the user's tier
    let userTier = null;
    for (const [tier, threshold] of Object.entries(tierThresholds).reverse()) {
      if (adjustedBalance >= parseFloat(threshold)) {
        if (_balance != -1)
          userTier = tier;
        else
          userTier = "none";
        break; // Found the tier, no need to continue checking
      }
    }

    // Tier has been determined successfully
    return { userTier, balance: adjustedBalance };
  } catch (error) {
    // Log the error for debugging
    console.error(`Error retrieving token balance for chatId ${chatId}:`, error);
    await bot.sendMessage(chatId, "Failed to retrieve token balance. There might be an issue with the token address provided or the network. Please try again later.");
    return null;
  }
}

async function getBalanceFromWallet(senderAddress) {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const tokenDecimals = DECIMAL; // Replace with your token's actual decimals
  console.log("Decimals: ", DECIMAL, " Contract: ", contractAddress);
  try {
    // Fetching the token balances using Alchemy
    const balances = await alchemy.core.getTokenBalances(senderAddress, [contractAddress]);
    const tokenBalanceData = balances.tokenBalances.find(token => token.contractAddress.toLowerCase() === contractAddress.toLowerCase());

    if (!tokenBalanceData || tokenBalanceData.tokenBalance === '0') {
      await bot.sendMessage(chatId, "Your token balance is zero or could not be retrieved. Please ensure you have the tokens and try again.");
      return 0;
    }

    // Convert the token balance from hexadecimal to decimal and adjust for decimals
    const balanceBigInt = BigInt(tokenBalanceData.tokenBalance);
    let adjustedBalance = Number(balanceBigInt) / Math.pow(10, tokenDecimals);
    return adjustedBalance;
  }
  catch (err) {
    console.error(err);
    return 0;
  }
}

async function determineUserTierByBalance(balance) {
  try {
    console.log(balance, typeof balance);
    const adjustedBalance = balance;

    let userTier = null;
    for (const [tier, threshold] of Object.entries(tierThresholds).reverse()) {
      if (adjustedBalance >= parseFloat(threshold)) {
        userTier = tier;
        break;
      }
    }

    return userTier;
  } catch (error) {
    console.error(`${error}`);
    return null;
  }
}

async function isTrialMode(chatId) {
  const trialData = await getUserTrialData(chatId);
  const period = 7 * 24 * 60 * 60; // 7 days
  if (!trialData || !trialData.post_url) return false;
  const isTweet = await checkTweet(trialData.post_url);
  if ((parseInt(trialData.trial) + period > (new Date()).getTime()) && !isTweet) {
    await awaitVerificationWarning(chatId);
    return false;
  }
  return ((parseInt(trialData.trial) + period) > (new Date()).getTime() && isTweet);
}

let registerTradingId = new Map();

async function awaitVerificationWarning(chatId) {
  await bot.sendMessage(chatId, `We've noticed that the verification post has been deleted. Please note that deleting the verification post violates the terms of the free trial. To continue enjoying our services, please post again and maintain the verification post.`);
}

async function awaitingConfirmTradingID(chatId, id) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Accept', callback_data: 'register_tradingID_accept' },
          { text: 'Cancel', callback_data: 'register_tradingID_cancel' },
        ]
      ]
    }
  };

  registerTradingId.set(chatId, id);
  bot.sendMessage(chatId, `You will be registered as ${id}`, opts);
}

async function updateUserTiersHourly() {
  console.log('Checking user tiers for updates...');
  let txStore = new Map();
  db.all(`SELECT chat_id, wallet_address, tier FROM user_verification`, async (err, users) => {
    if (err) {
      console.error(`Error retrieving users for tier check: ${err.message}`);
      return;
    }

    if (!users || !users.recordset) {
      console.error("Error users not found");
      return;
    }
    console.log(users.recordset);
    for (const user of users.recordset) {
      if (!txStore.has(user.chat_id))
        txStore.set(user.chat_id, 0);
      if (user.wallet_address == `${"Trial" + user.chat_id}`) continue;
      const curBalance = await getBalanceFromWallet(user.wallet_address);
      const _balance = txStore.get(user.chat_id) + curBalance;
      console.log(`balance:   ${_balance}`);
      txStore.set(user.chat_id, _balance);
    }
    for (const user of users.recordset) {
      const currentTier = user.tier;
      if (currentTier == "none" || user.wallet_address == `${"Trial" + user.chat_id}`) continue;
      console.log(`total:  ${txStore.get(user.chat_id)}`);
      const totalBalance = txStore.get(user.chat_id);
      const newTier = await determineUserTierByBalance(totalBalance); // Adjust this function as needed
      console.log(newTier);
      if (newTier !== currentTier && currentTier != "none") {
        let tierToUpdate = newTier === null ? "none" : newTier;
        if (isTrialMode(user.chat_id)) {
          return;
        }
        await db.run(`UPDATE user_verification SET tier = '${tierToUpdate}' WHERE chat_id = '${user.chat_id}' AND tier != 'none' AND wallet_address != '${"Trial" + user.chat_id}'`, (error) => console.log(error));
        console.log(`User ${user.chat_id} tier updated from ${currentTier} to ${tierToUpdate}`);

        if (shouldUnsubscribeFromFeeds(currentTier, newTier)) {
          await unsubscribeUserFromRestrictedFeeds(user.chat_id, newTier);
        }

        let message = tierToUpdate === "Unverified" ?
          `You no longer meet the minimum balance requirements for any tier and have been set to Unverified.` :
          `Your tier has been updated to: ${tierToUpdate}.`;
        bot.sendMessage(user.chat_id, message);
      }
    }
  });
}

function shouldUnsubscribeFromFeeds(oldTier, newTier) {
  const tierOrder = ['Unverified', 'Starter', 'Standard', 'Premium']; // Order tiers from lowest to highest
  return tierOrder.indexOf(newTier) < tierOrder.indexOf(oldTier);
}

async function unsubscribeUserFromRestrictedFeeds(chatId, tier) {
  // Define the tier restrictions for each feed
  const restrictedFeeds = {
    'axe': ['Standard', 'Premium'],
  };

  // Iterate through each feed and unsubscribe the user if they no longer have access
  Object.entries(restrictedFeeds).forEach(async ([feedName, allowedTiers]) => {
    if (!allowedTiers.includes(tier)) {
      await unsubscribeUser(chatId, feedName);
      bot.sendMessage(chatId, `You have been unsubscribed from the ${feedName} feed due to your updated tier.`);
    }
  });
}

// Prompt the user for their X handle.

async function promptTwitterAccount(chatId) {
  bot.sendMessage(chatId, "Please input your X username (without the @).");
  awaitingXAccount.set(chatId, true);
}

// Update X account username for trial mode
async function updateXAccount(chatId, xAccount) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE user_verification SET x_handle = '${xAccount}' WHERE chat_Id = '${chatId}' AND wallet_address = '${"Trial" + chatId}'`, function (err) {
      if (err) {
        console.error(`Error updating user's X username`);
        reject(err);
      } else {
        console.log("successfully updated user's X username");
        resolve(this.changes > 0); // returns true if the subscription was updated
      }
    });
  });
}

async function awaitPostUrl(chatId) {
  awaitingPostUrl.set(chatId, true);
}

async function checkTweet(url) {
  console.log(url)
  try {
    const data = await roClient.v2.tweets(url);
    console.log(data.data);
    if (data.data == undefined) return false;
    else {
      const tweetText = data.data[0].text;
      if (tweetText.indexOf("@JestTech") >= 0 && tweetText.indexOf("$JEST") >= 0) return true;
      return false;
    }
  }
  catch (error) {
    return false;
  }
}

function validateTweetURL(url) {
  if (url.indexOf("https") >= 0) {
    const index = url.indexOf("status/");
    const id = url.substr(index + 7, 19);
    return id;
  }
  return url;
}

async function postToX(chatId, urls) {
  const url = validateTweetURL(urls);
  if (await checkTweet(url))
    return new Promise((resolve, reject) => {
      db.run(`UPDATE user_verification SET post_url = '${url}', trial = '${(new Date()).getTime()}' WHERE chat_id = '${chatId}'`, function (err) {
        if (err) {
          console.error(`Error updating user's X post Url`);
          reject(err);
        } else {
          console.log("successfully updated user's X post Url");
          db.run(`UPDATE user_verification SET tier = 'Standard' WHERE chat_id = '${chatId}' AND tier != 'none'`, (error) => console.log(error));
          bot.sendMessage(chatId, "Enjoy your trial mode!");

          resolve(this.changes > 0); // returns true if the subscription was updated
        }
      });
    });
  else {
    bot.sendMessage(chatId, "Incorrect tweet Id or url.");
  }
}

async function getTweet(chatId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT post_url FROM user_verification WHERE chatId = '${chatId}'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching post_url requests: ${err.message}`);
        reject(err);
      } else {
        resolve(rows[0].post_url);
      }
    });
  });
}

async function verifyTwitterAccount(chatId) {
  window.location.href = `process.env.REDIRECT_URL/authorize`;
}

// Update X account username for trial mode
async function updateAgreeToTerms(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE user_verification SET agreedToTerms = '1' WHERE chat_Id = '${chatId}'`, function (err) {
      if (err) {
        console.error(`Error updating user's agreedToTerms`);
        reject(err);
      } else {
        console.log("successfully updated user's agreedToTerms");
        resolve(this.changes > 0); // returns true if the subscription was updated
      }
    });
  });
}

async function checkXAccount(xAccount) {
  const createdTime = await getTwitterAccountCreationTime(xAccount);
  // Get the current date
  const currentDate = new Date();

  // Subtract 1 month from the current date
  currentDate.setMonth(currentDate.getMonth() - 1);
  console.log(createdTime, " ", currentDate);
  return createdTime.getTime() <= currentDate.getTime();
  // return true;
}

// Function to check X account for trial mode
async function handleTrialProcess(chatId, xAccount) {
  const currentChatId = await getChatIdFromTweeterName(xAccount);
  if (currentChatId) {
    await bot.sendMessage(chatId, "This X account is already registered. Please try again with another one");
    return;
  }
  console.log(chatId)
  await updateXAccount(chatId, xAccount);
  if (checkXAccount(xAccount)) {
    const opts = {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'I agree', callback_data: 'agree_for_trial' },
            { text: 'I do not agree', callback_data: 'disagree_for_trial' }
          ]
        ]
      }
    };
    bot.sendMessage(chatId, 'Do you agree to the terms and conditions found in our [Documentation](https://jesterbot.gitbook.io/jesterbot/faq/terms-and-conditions)?', opts);

  }
}

// Function to handle the /trial command
async function handleTrialCommand(chatId, xHandle) {
  // Check if the user has already received a free trial
  const trialData = await getUserTrialData(chatId);
  const trialMessage = `
    🐦 *Free Trial* 🐦

    Enjoy your free trial! Here's what you recieve:
    - Access to Standard Tier for 14 days.
    - No credit card required.
    - Instant setup.
    - Requires an X account.
    `;

  if (!trialData) {
    await insertUser(chatId, `${"Trial" + chatId}`, "Trial").then(async () => {

    }).catch(dbError => {
      console.error(`Error inserting user into database: ${dbError.message}`);
    });
    await bot.sendPhoto(chatId, imagePathTrial, {
      caption: trialMessage,
      parse_mode: 'Markdown'
    });
    await promptTwitterAccount(chatId);
  }
  else if (trialData.trial > 0) {
    bot.sendMessage(chatId, "You have already used your free trial. To continue using JesterBot, buy $JEST and /verify.");
  }

  else {
    await promptTwitterAccount(chatId);
  }
}

const callback_trial = async (msg, match) => {
  const chatId = msg.chat.id;
  const xHandle = match[1];
  const response = await handleTrialCommand(chatId, xHandle);
  // bot.sendMessage(chatId, response);
}
// Example usage of the handleTrialCommand function within a Telegram bot command handler
bot.onText(/\/trial/, callback_trial);

// Change Wallet command
bot.onText(/\/change_wallet/, (msg) => {
  const chatId = msg.chat.id;
  clearAwaitingValues(chatId);

  // Step 2: Start the wallet change process
  bot.sendMessage(chatId, "To change your wallet, please send a 0.0 ETH transaction from your new wallet to itself and provide the transaction hash.");
  awaitingWalletChange.set(chatId, true);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (isRateLimited(chatId)) {
    bot.sendMessage(chatId, "You're sending messages too fast. Please try again later.");
    return; // Stop processing this message
  }

  // Step 3: Process the transaction hash
  if (awaitingWalletChange.has(chatId)) {
    const txHash = validator.escape(msg.text.trim());
    awaitingWalletChange.delete(chatId);

    const newWalletAddress = await getSenderAddressFromTxHash(txHash, chatId);
    if (newWalletAddress) {
      // Step 4: Update the user's wallet address in the database
      await updateUserWalletAddress(chatId, newWalletAddress);

      // Step 5: Notify the user
      bot.sendMessage(chatId, `Your wallet address has been updated to: ${newWalletAddress}`);
    } else {
      bot.sendMessage(chatId, "Invalid transaction hash. Please try again.");
    }
  }

  else if (awaitingNewWallet.has(chatId)) {
    const txHash = validator.escape(msg.text.trim());
    awaitingNewWallet.delete(chatId);
    const walletAddress = await getSenderAddressFromTxHash(txHash);

    try {
      await insertUser(chatId, walletAddress, "none");
      bot.sendMessage(chatId, `New wallet has been added successfully`);
      await updateUserTiersHourly();
    }
    catch (err) {
      console.error(err);
      bot.sendMessage(chatId, "Invalid transaction hash or already registered this wallet");
    }
  }
  else if (awaitingAction.get(chatId) == "register_tradingID") {
    console.log("Parsing tradingView ID");
    const tradingId = msg.text.trim();
    console.log(tradingId);
    await awaitingConfirmTradingID(chatId, tradingId);
    //bot.sendMessage(chatId, "⚠️ Tradingview ID received, please allow up to 48 hours for access");
  }
  else if (awaitingXAccount.get(chatId)) {
    const xAccount = msg.text.trim();
    awaitingXAccount.delete(chatId);
    await handleTrialProcess(chatId, xAccount);
  }
});


async function updateUserWalletAddress(chatId, newWalletAddress) {
  return new Promise(async (resolve, reject) => {
    // Check if the new wallet address is already in use
    const existingUserChatId = await isWalletAlreadyUsed(newWalletAddress);
    if (existingUserChatId && existingUserChatId !== chatId) {
      reject("This wallet address is already in use by another user.");
      return;
    }

    // Update the wallet address in the database
    db.run(`UPDATE user_verification SET wallet_address = '${newWalletAddress}' WHERE chat_id = '${chatId}'`, function (err) {
      if (err) {
        console.error(`Error updating user's wallet address: ${err.message}`);
        reject(err);
      } else {
        resolve(this.changes > 0); // returns true if the wallet address was updated
      }
    });
  });
}


// Don't forget to call this function periodically as needed 
setInterval(updateUserTiersHourly, 3000000); // every hour

// Function to get all associated wallets for chatID

function getUserWallets(chatId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT tier, wallet_address FROM user_verification WHERE chat_id = '${chatId}'  AND wallet_address != '${"Trial" + chatId}'`, (err, row) => {
      if (err) {
        console.error(`Error when getting user verification status: ${err.message}`);
        reject(err);
      } else {
        resolve(row.recordset);
      }
    });
  });
}

// Function to get a user's tier and verification time
function getUserVerificationStatus(chatId) {
  const trial = isTrialMode(chatId);
  return new Promise((resolve, reject) => {
    db.all(`SELECT tier, verified_at, wallet_address FROM user_verification WHERE chat_id = '${chatId}' AND tier != 'none' AND wallet_address != '${"Trial" + trial ? "" : chatId}'`, (err, row) => {
      if (err) {
        console.error(`Error when getting user verification status: ${err.message}`);
        reject(err);
      } else {
        resolve(row.recordset[0]);
      }
    });
  });
}

function isWalletAlreadyUsed(walletAddress) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT chat_id FROM user_verification WHERE wallet_address = '${walletAddress}'`, (err, row) => {
      if (err) {
        console.error(`Error when checking wallet address: ${err.message}`);
        reject(err);
      } else {
        resolve(row ? row.recordset[0].chat_id : null);
      }
    });
  });
}

function clearAwaitingValues(chatId) {
  awaitingAction.set(chatId, "none");
  awaitingNewWallet.delete(chatId);
  awaitingWalletChange.delete(chatId);
  awaitingConfirmToRemove.delete(chatId);
  awaitingContractAddress.delete(chatId);
  awaitingVerification.delete(chatId);
}


bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  clearAwaitingValues(chatId);
  // Check if the user is verified before displaying the main menu
  const userStatus = await getUserVerificationStatus(chatId);
  if ((!userStatus || !userStatus.verified_at) && !isTrialMode(chatId)) {
    // User is not verified, prompt for verification
    bot.sendMessage(chatId, "Please verify your account before accessing the menu. Use /verify to start the verification process.");
  } else {
    // User is verified, display the main menu
    await displayMainMenu(chatId);
  }
});

function escapeMarkdown(text) {
  return text.replace(/([*_`[\]()])/g, '\\$1'); // Escapes Markdown special characters
}

async function displayMainMenu(chatId) {
  try {
    const bots = await retrieveBots();
    const userStatus = await getUserVerificationStatus(chatId);
    const userTier = `*Tier:* ${userStatus.tier}`;
    const userWallet = `*Wallet:* ${getReducedWalletAddress(userStatus.wallet_address)}`;
    const preferredBotSimpleNames = await getUserBotSelections(chatId, 'eth');
    const preferredBotNames = preferredBotSimpleNames.map(simpleName => {
      const botEntry = bots.find(bot => bot.simpleName === simpleName);
      return botEntry ? `_${botEntry.name}_` : '_Unknown Bot_';
    });

    const requestedContracts = await getUserRequests(chatId);
    const subscribedFeedsSimpleNames = await getUserSubscribedFeeds(chatId);
    const feeds = await retrieveFeeds();
    const subscribedFeedsWithEmojis = subscribedFeedsSimpleNames.map(feedName => {
      const curFeed = feeds.filter(feed => feed.feed_name == feedName)[0];
      return curFeed.display_name || curFeed.feed_name;
    });

    let responseMessage = `🃏 *JesterBot Main Menu* 🃏\n\n` +
      `🎖️ *Your Status*\n${userTier}\n${userWallet}\n\n` +
      `📡 *Subscribed Feeds*\n${subscribedFeedsWithEmojis.length > 0 ? subscribedFeedsWithEmojis.join('\n') : 'None'}\n\n` +
      `🤖 *Preferred Interface*\n${preferredBotNames.length > 0 ? preferredBotNames.join(', ') : 'None'}\n\n` +
      `📜 *Requested Contract Addresses*\n${requestedContracts.length > 0 ? requestedContracts.join('\n') : 'None'}\n\n` +
      `Select an option below to continue exploring!`;

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          // [{ text: '⚙️ Settings', callback_data: 'choose_feeds' }],
          [{ text: '📊 Jester Analytics', url: 'https://t.me/jesterStatsBot' }],
          [{ text: '⚙️ Configuration', callback_data: 'setting_feeds' }],
          [{ text: '🤝 Referrals', callback_data: 'referrals' }],
          [
            { text: '📚 Docs', url: 'https://jester.gitbook.io/docs/' },
            { text: '👥 Socials', url: 'https://linktr.ee/JestTech' }
          ]
          //[{ text: '🔍 Request a Token', callback_data: 'request_token' }],          
        ]
      }
    };
    if (userStatus.tier == "Premium") {
      opts.reply_markup.inline_keyboard.splice(1, 0, [{ text: '🆔 Register TradingView ID', callback_data: 'register_tradingID' }]);
    }

    bot.sendMessage(chatId, responseMessage, opts);
  } catch (error) {
    console.error(`Failed to generate menu: ${error.message}`);
    bot.sendMessage(chatId, "There was an error processing your menu request. Please try again later.");
  }
}



bot.onText(/\/request/, (msg) => {
  const chatId = msg.chat.id;
  clearAwaitingValues(chatId);
  // Set the user's chat ID as awaiting a contract address
  awaitingContractAddress.set(chatId, true);
  // Ask the user to paste the contract address
  bot.sendMessage(chatId, "Please paste the Contract address below:");
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (!msg.text) return;

  const text = msg.text.trim();

  // Check if the user is changing their wallet
  if (awaitingWalletChange.has(chatId)) {
    const txHash = text;
    awaitingWalletChange.delete(chatId);

    try {
      // Function to verify transaction hash and get sender's address
      const senderAddress = await verifyTransactionHashAndRetrieveAddress(txHash, chatId);

      if (senderAddress) {
        // Update the user's wallet address in the database
        await updateUserWalletAddress(chatId, senderAddress);
        // Send a success message to the user
        bot.sendMessage(chatId, "Your wallet address has been successfully updated.");
      } else {
        // Handle the case where the transaction does not meet the criteria
        bot.sendMessage(chatId, "The transaction hash provided does not meet the verification criteria. Please try again.");
      }
    } catch (error) {
      console.error(`Error processing wallet change: ${error.message}`);
      bot.sendMessage(chatId, "There was an error processing your wallet change. Please try again.");
    }
    return; // Exit the function to prevent further processing
  }

  // Check if the user has been prompted to enter a contract address
  if (awaitingContractAddress.has(chatId)) {
    const contractAddress = validator.escape(msg.text.trim());
    awaitingContractAddress.delete(chatId);

    // Validate the contract address format
    if (!ethAddressRegex.test(text)) {
      bot.sendMessage(chatId, "This does not appear to be a valid contract address. Please check and try again.");
      return;
    }

    insertContractRequest(chatId, text).then(result => {
      if (result.alreadyRequested) {
        bot.sendMessage(chatId, "You have already requested this contract address.");
      } else {
        bot.sendMessage(chatId, `Your request for contract address *${text}* has been received.`, { parse_mode: 'Markdown' })
          .then(sentMessage => {
            setTimeout(() => {
              bot.deleteMessage(chatId, sentMessage.message_id).then(() => {
                displayMainMenu(chatId);
              }).catch(delError => {
                console.error(`Failed to delete message: ${delError.message}`);
              });
            }, 3000);
          }).catch(sendError => {
            console.error(`Failed to send message: ${sendError.message}`);
          });
      }
    }).catch(error => {
      console.error(`Failed to process the request: ${error.message}`);
      bot.sendMessage(chatId, "There was an error processing your request. Please try again later.");
    });
  }
});

const callback_verify = async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text != '/verify') return;
  clearAwaitingValues(chatId);

  const trialData = await getUserTrialData(chatId);
  if (trialData && trialData.trial > 0) {
    await bot.sendMessage(chatId, "You are currently using free trial mode. After trial mode ends you can verify with your wallet.");
    return;
  }
  try {
    const userStatus = await getUserVerificationStatus(chatId);
    if (userStatus && userStatus.tier) {
      const opts = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Add new wallet', callback_data: 'new_wallet' },
              { text: 'Remove wallet', callback_data: 'remove_wallet' },
            ]
          ]
        }
      };
      bot.sendMessage(chatId, `You are already verified as part of the ${userStatus.tier} tier.`, opts);
    } else {
      const opts = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'I agree', callback_data: 'agree' },
              { text: 'I do not agree', callback_data: 'disagree' }
            ]
          ]
        }
      };
      bot.sendMessage(chatId, 'Do you agree to the terms and conditions found in our [Documentation](https://jesterbot.gitbook.io/jesterbot/faq/terms-and-conditions)?', opts);
    }
  } catch (error) {
    console.error(`Failed to get verification status: ${error.message}`);
    bot.sendMessage(chatId, "There was an error processing your request. Please try again later.");
  }
}
bot.onText(/\/verify/, callback_verify);

// Call this function when verification is successful
async function handleVerificationSuccess(chatId, userTier) {
  // Send a message indicating verification success and the user's tier
  await bot.sendMessage(chatId, `Verification successful! You are classified under the "${userTier}" tier.`);

  // Send the feed options based on the user's tier
  await displayMainMenu(chatId);
}

async function sendAnotherWallet(chatId) {
  const opts = {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Yes', callback_data: 'another_wallet_agree' },
          { text: 'No', callback_data: 'another_wallet_disagree' }
        ]
      ]
    }
  };
  bot.sendMessage(chatId, 'Would you like to submit another wallet?', opts);
}

bot.on('message', async (msg) => {
  let data = msg.text;
  const chatId = msg.chat.id;
  let txHashs = [];
  if (txHashMap.get(chatId))
    txHashs = txHashMap.get(chatId);
  // Check if this chat is awaiting verification
  if (awaitingVerification.get(chatId)) {
    if (!data.startsWith('toggle_wallet_')) {
      const transactionHash = data.trim();
      txHashs.push(transactionHash);
      txHashMap.set(chatId, txHashs);
      await sendAnotherWallet(chatId);
    }
  }
  if (awaitingPostTweet.has(chatId)) {
    awaitingPostTweet.delete(chatId);
    const url = data.trim();
    await postToX(chatId, url);
  }

  else if (awaitingConfirmToRemove.has(chatId)) {
    const removeWallet = data.trim();
    const curWallet = awaitingConfirmToRemove.get(chatId);
    console.log(removeWallet);
    console.log(curWallet);
    if (removeWallet == curWallet.slice(0, 7)) {
      //remove selected wallet
      await removeWalletFromDB(chatId, curWallet);
    }
    else if (curWallet == "all") {
      // remove all associated wallets.
      await removeWalletFromDB(chatId, "all");
    }
    else {
      bot.sendMessage(chatId, "Confirm failed");
    }
    awaitingConfirmToRemove.delete(chatId);
  }
});

function getReducedWalletAddress(address) {
  if (address.indexOf("Trial") >= 0) return "Trial";
  else
    return address.substr(0, 7) + '...' + address.substr(-4);
}

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  clearAwaitingValues(chatId);
  console.log(msg.text);
  if (msg.text != '/status') return;

  try {
    const userStatus = await getUserVerificationStatus(chatId);
    if (userStatus && userStatus.tier) {
      bot.sendMessage(chatId, `🎖️ Current Status` + '\n\n' +
        `Current Tier: ${userStatus.tier}` + '\n' +
        `Wallet Address: ${getReducedWalletAddress(userStatus.wallet_address)}`);
    } else {
      bot.sendMessage(chatId, "You do not have a verified tier status at this time. Use /verify to start the verification process.");
    }
  } catch (error) {
    console.error(`Failed to get user status: ${error.message}`);
    bot.sendMessage(chatId, "There was an error processing your request. Please try again later.");
  }
});

async function getWalletsFromTx(txHashs, chatId) {
  let wallets = [];
  console.log(txHashs);
  for (let i = 0; i < txHashs.length; i++) {
    const wallet = await getSenderAddressFromTxHash(txHashs[i], chatId);
    wallets.push(wallet);
  }
  return wallets;
}

async function isDBContainsWallets(chatId, wallets) {
  console.log(wallets);
  for (let i = 0; i < wallets.length; i++) {
    const isContains = await new Promise((resolve, reject) => {
      db.all(`SELECT tier FROM user_verification WHERE wallet_address='${wallets[i]}'`, async (err, users) => {
        console.log(users.recordset);
        if (users && users.recordset.length > 0) {
          console.log("found", wallets[i]);
          resolve("found");
        }
        else {
          console.log("nothing");
          resolve("nothing");
        }
      });
    });
    console.log(isContains);
    if (isContains == "found") return true;
  };
  return false;
}

async function handleUserVerification(chatId) {
  let txHashContent = '0: Cancel verification' + "\n";
  console.log("aaa");
  const txHashs = txHashMap.get(chatId);
  let inlineKeyboard = [];
  console.log("bbb");
  const wallets = await getWalletsFromTx(txHashs, chatId);
  console.log("duplicates");
  const hasDuplicates = new Set(wallets).size != wallets.length;

  if (hasDuplicates) {
    await bot.sendMessage(chatId, "You have entered multiple transactions for the same wallet address.");
    txHashMap.delete(chatId);
    awaitingVerification.delete(chatId);
    return;
  }

  if (await isDBContainsWallets(chatId, wallets)) {
    await bot.sendMessage(chatId, "Some wallet addresses you inputed are already registered");
    txHashMap.delete(chatId);
    awaitingVerification.delete(chatId);
    return;
  }

  console.log("ccc");
  inlineKeyboard = wallets.map((value, index) => {
    let val = value;
    return [
      {
        text: `${getReducedWalletAddress(val)}`,
        callback_data: `toggle_wallet_${index + 1}`
      }
    ];
  });

  inlineKeyboard.push([{
    text: `Cancel Verification`,
    callback_data: `toggle_wallet_0`
  }]);

  const opts = {
    chat_id: chatId,
    reply_markup: { inline_keyboard: inlineKeyboard }
  };
  console.log("ddd");
  await bot.sendMessage(chatId, "Select your default wallet address here!", opts);
}

async function handleMultiVerification(chatId) {
  await bot.sendMessage(chatId, 'Submit another txn hash for verification.');
}

async function handleUserAgreement(chatId) {
  // Send a thank you message
  await bot.sendMessage(chatId, 'Thank you for agreeing to the terms and conditions.');

  // Send the verification instructions
  const verificationInstructions = 'To complete your account verification, please follow these steps:\n\n' +
    '1. Execute a zero (0) ETH transaction from your wallet to the same wallet address.\n' +
    '2. After the transaction is confirmed, locate and copy the "Transaction Hash" from your Ethereum wallet or explorer.\n' +
    '3. Return to this chat and paste the transaction hash here.\n\n' +
    'The zero ETH transaction is a secure method to confirm the ownership of your Ethereum account and does not involve any actual transfer of funds. This verification step is essential for the security and integrity of our services.';
  await bot.sendMessage(chatId, verificationInstructions);

  // Set the user's status to awaiting verification
  awaitingVerification.set(chatId, true);
}

//SUBSCRIPTION LOGIC
//==================
// This function subscribes a user to a feed
async function subscribeUser(chatId, feedName, preferredBot = null) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO subscriptions (chat_id, feed_name, preferred_bot) VALUES ('${chatId}', '${feedName}', ${preferredBot}) ON CONFLICT(chat_id, feed_name) DO NOTHING`, function (err) {
      if (err) {
        console.error(`Error subscribing user to feed: ${err.message}`);
        reject(err);
      } else {
        resolve(this.lastID); // returns the last inserted row id
      }
    });
  });
}

// This function unsubscribes a user from a feed
async function unsubscribeUser(chatId, feedType) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM subscriptions WHERE chat_id = '${chatId}' AND feed_name = '${feedType}'`, function (err) {
      if (err) {
        reject(`Failed to unsubscribe from feed: ${err.message}`);
      } else {
        resolve(this.changes > 0); // returns true if the subscription was removed
      }
    });
  });
}

async function addReferralData(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO referrals (chatId, followers)
      SELECT '${chatId}', ''
      WHERE NOT EXISTS (
        SELECT 1
        FROM referrals
        WHERE chatId = '${chatId}'
      )
    `, function (err) {
      if (err) {
        console.error(`Error adding user to referral: ${err.message}`);
        reject(err);
      } else {
        resolve(this.changes > 0); // returns true if the subscription was added
      }
    });
  });
}


async function getFollowers(chatId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT followers FROM referrals WHERE chatId = '${chatId}'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching alert status: ${err.message}`);
        reject(err);
      } else {
        if (rows.recordset[0])
          resolve(rows.recordset[0].followers);
        else resolve(false);
      }
    });
  });
}

async function generateIDCode(chatId) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let idCode = "";
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    idCode += characters.charAt(randomIndex);
  }

  await updateReferralId(chatId, idCode);
  await addReferralData(chatId);
  return idCode;
}

async function updateFollowers(ref_chatId, chatId) {
  let followers = await getFollowers(chatId);
  console.log("sss", followers, chatId, ref_chatId);
  // Check if current user is already registered as follower for refer user.
  if (followers && followers.indexOf(ref_chatId) >= 0) {
    console.log(`You already fellow ${ref_chatId} account`)
    return;
  }

  if (!followers) followers = ref_chatId;
  else
    followers += `,${ref_chatId}`;
  console.log(followers);
  return new Promise((resolve, reject) => {
    db.run(`UPDATE referrals SET followers = '${followers}' WHERE chatId = '${chatId}'`, function (err) {
      if (err) {
        console.error(`Error updating user's followers`);
        reject(err);
      } else {
        console.log("successfully updated user's followers");
        resolve(this.changes > 0); // returns true if the subscription was updated
      }
    });
  });
}

async function updateReferralId(chatId, updatedId) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE user_verification SET referId = '${updatedId}' WHERE chat_id = '${chatId}' AND tier != 'none' AND wallet_address != '${"Trial" + chatId}'`, function (err) {
      if (err) {
        console.error(`Error updating user's referId`);
        reject(err);
      } else {
        console.log("successfully updated user's referId");
        resolve(this.changes > 0); // returns true if the subscription was updated
      }
    });
  });
}

async function getReferralId(chatId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT referId FROM user_verification WHERE chat_id = '${chatId}' AND tier != 'none' AND wallet_address != '${"Trial" + chatId}'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching referId status: ${err.message}`);
        reject(err);
      } else {
        if (rows.recordset[0])
          resolve(rows.recordset[0].referId);
        else resolve(null);
      }
    });
  });
}

async function getUserTrialData(chatId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT trial, x_handle, post_url FROM user_verification WHERE chat_id = '${chatId}' AND wallet_address = '${"Trial" + chatId}'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching trial time status: ${err.message}`);
        reject(err);
      } else {
        console.log(rows.recordset);
        if (rows.recordset[0])
          resolve(rows.recordset[0]);
        else resolve(null);
      }
    });
  });
}

async function getChatIdFromRef(refUser) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT chat_id FROM user_verification WHERE referId = '${refUser}' AND tier != 'none'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching chat_Id from refer user: ${err.message}`);
        reject(err);
      } else {
        if (rows.recordset[0])
          resolve(rows.recordset[0].chat_id);
        else resolve(null);
      }
    });
  });
}

async function getChatIdFromTweeterName(x_handle) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT chat_id FROM user_verification WHERE x_handle = '${x_handle}' AND tier != 'none'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching chat_Id from X user: ${err.message}`);
        reject(err);
      } else {
        if (rows.recordset[0])
          resolve(rows.recordset[0].chat_id);
        else resolve(false);
      }
    });
  });
}

// Display Referral menu
async function showReferralMenu(chatId) {
  let userId = await getReferralId(chatId);
  if (!(await getUserVerificationStatus(chatId))) {
    await bot.sendMessage(chatId, "You need to verify with transactions first to register referral ID");
    return;
  }
  console.log("=========================", userId);
  if (!userId) {
    userId = await generateIDCode(chatId);
  }
  const followers = await getFollowers(chatId);
  console.log("followers", followers);

  let followerCount = 0;
  if (followers) followerCount = followers.split(",").length;
  let responseMessage = `            🤝 Referrals 🤝\n\n` +
    `🎖️ Your Id\n${userId}\n\n` +
    `👥 Referred users\n${followerCount}\n\n` +
    `💯 Crowns\n${100 * followerCount}\n\n` +
    `📜 Referral code\n<code>${`https://t.me/JesterAlphaBot?start=` + userId}</code>\n\n`;

  const opts = {
    parse_mode: 'HTML',
    // reply_markup: {
    //   inline_keyboard: [
    //     [{ text: '🤝 Update Referral Code (coming soon)', callback_data: 'update_referral' }],
    //   ]
    // }
  };
  bot.sendMessage(chatId, responseMessage, opts);
}

async function followJesterBot(chatId) {
  // set agreed to terms
  await updateAgreeToTerms(chatId);

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Verify with X', url: `${process.env.REDIRECT_URL}/authorize` }],
      ],
    }
  }
  await bot.sendMessage(chatId, `To begin the free Trial, please verify your X account`, options);
}
async function awaitingRegisterTradingID(chatId, id) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE user_verification SET tradingId = '${id}' WHERE chat_id = '${chatId}' AND tier != 'none' AND wallet_address != '${"Trial" + chatId}'`, function (err) {
      if (err) {
        console.error(`Error updating user's tradingId`);
        reject(err);
      } else {
        console.log("successfully updated user's tradingID");
        resolve(this.changes > 0); // returns true if the subscription was updated
      }
    });
  });
}

// Function to handle the /subscribe and /unsubscribe commands
bot.onText(/\/(subscribe|unsubscribe) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  clearAwaitingValues(chatId);

  const action = match[1]; // 'subscribe' or 'unsubscribe'
  const feedType = match[2].trim(); // Extract the feed type from the command argument
  let response;

  try {
    if (action === 'subscribe') {
      const didSubscribe = await subscribeUser(chatId, feedType);
      response = didSubscribe ? `Subscribed to ${feedType}.` : `Already subscribed to ${feedType}.`;
    } else {
      const didUnsubscribe = await unsubscribeUser(chatId, feedType);
      response = didUnsubscribe ? `Unsubscribed from ${feedType}.` : `Not subscribed to ${feedType}.`;
    }
  } catch (error) {
    response = `An error occurred: ${error}`;
  }

  bot.sendMessage(chatId, response);
});

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const messageIdToDelete = callbackQuery.message.message_id; // Capture messageId

  // Log when a callback query is received
  console.log(`Received callback query from chatId: ${chatId} with data: ${data}`);

  try {
    // Handle the case when a user chooses to view or modify feed subscriptions
    if (data === 'setting_feeds') {
      await displayFeedSettings(chatId, messageId);
    }
    // Handle the case when a user toggles a feed subscription
    else if (data.startsWith('toggle_feed_')) {
      const feedName = data.split('toggle_feed_')[1];
      await toggleSubscription(chatId, feedName, messageId);
      await displayFeedOptions(chatId, messageId, feedName); // Use callbackQuery.message.message_id here
    }
    else if (data.startsWith('toggle_setting_feed_')) {
      const feedName = data.split('toggle_setting_feed_')[1];
      await displaySettingForFeed(chatId, null, feedName);
    }

    else if (data.startsWith('verify_for_trial')) {
      await verifyTwitterAccount(chatId);
      // await checkVerifyForTrial(chatId);
    }
    else if (data.startsWith('post_To_X')) {
      await awaitPostUrl(chatId);
    }
    // Back to subs
    else if (data === 'back_to_subscriptions') {
      await displayFeedOptions(chatId, callbackQuery.message.message_id);
    }
    else if (data.startsWith('alert_on_')) {
      const feedName = data.split('alert_on_')[1];
      await toggleAlertStatus(chatId, messageId, feedName);
    }
    else if (data.startsWith('toggle_wallet_')) {
      let ind = data.split('toggle_wallet_')[1];
      //Determine the user's tier based on their transaction hash
      if (ind == "0") {
        bot.deleteMessage(chatId, messageId);
        return;
      }

      const txHashs = txHashMap.get(chatId);
      const mainIndex = (parseInt(ind) - 1);
      console.log(mainIndex);
      const mainWalletHash = txHashs[mainIndex];
      txHashs.splice(mainIndex, 1);
      txHashs.push(mainWalletHash);

      let balances = 0;

      console.log(txHashs);
      txHashs.map((transactionHash) => {
        determineUserTier(transactionHash, chatId, (transactionHash == mainWalletHash ? balances : -1)).then(({ userTier, balance }) => {
          if (userTier) {
            // Get the sender's address from the transaction hash
            getSenderAddressFromTxHash(transactionHash, chatId).then(walletAddress => {
              // Insert the user into the database
              insertUser(chatId, walletAddress, userTier).then(() => {
                // Handle verification success
                balances += balance;
                if (transactionHash == mainWalletHash)
                  handleVerificationSuccess(chatId, userTier);
              }).catch(dbError => {
                console.error(`Error inserting user into database: ${dbError.message}`);
                bot.sendMessage(chatId, transactionHash.toString() + "\n" + `There was an error during the verification process. Please try again.`);
              });
            }).catch(err => {
              console.error(`Error getting sender address from transaction hash: ${err.message}`);
            });
          } else {
            bot.sendMessage(chatId, "Verification failed. Your token balance does not meet our minimum requirements for any tier.");
            sendUpgradePrompt(chatId);
          }
          // Regardless of the outcome, we're done with this verification attempt
          awaitingVerification.delete(chatId);
        }).catch(err => {
          console.error(`Error determining user tier: ${err.message}`);
          bot.sendMessage(chatId, "There was an error during the verification process. Please try again.");
        });
      });
      txHashMap.delete(chatId);
      awaitingVerification.delete(chatId);
    }
    else if (data === "new_wallet") {
      awaitingNewWallet.set(chatId, true);
      bot.sendMessage(chatId, "Submit new txn hash to add new wallet.")
    }

    else if (data.startsWith('toggle_remove_wallet_')) {
      const walletAddress = data.split('toggle_remove_wallet_')[1];
      await confirmWalletToRemove(chatId, walletAddress);
    }

    else if (data == "remove_wallet") {
      await awaitingRemovePanel(chatId);
      //awatingRemoveWallet.set(chatId, true);
    }
    // Handle bot selection callback query
    else if (data.startsWith('toggle_bot_')) {
      const botSimpleName = data.split('toggle_bot_')[1].split(',')[1];
      const feedName = data.split('toggle_bot_')[1].split(',')[0];
      const bots = await retrieveBots(); // Retrieve the list of bots here
      await toggleBotSelection(chatId, botSimpleName, messageIdToDelete, bots, feedName);
    }
    else if (data.startsWith('toggle_asset_')) {
      const assetData = data.split('toggle_asset_')[1].split(',');
      const feedName = assetData[0];
      const asset = assetData[1];
      const assets = await retrieveAssets(feedName);
      await toggleAssetSelection(chatId, asset, messageIdToDelete, assets, feedName);
    }
    else if (data.startsWith('enable_asset_')) {
      const feedName = data.split('enable_asset_')[1];
      const assets = await retrieveAssets(feedName);
      const selections = (await getUserAssetSelections(chatId, feedName)).assets.split(',');
      await displayAssetOptions(chatId, null, selections, assets, feedName);
    }
    // Handle finalize bot selection
    else if (data === 'finalize_bots' || data === 'finalize_assets') {
      // Confirm the user's bot selections and update the database as necessary
      let confirmationMessage;
      if (data == 'finalize_bots')
        confirmationMessage = await bot.sendMessage(chatId, "Your bot selections have been finalized.");
      else
        confirmationMessage = await bot.sendMessage(chatId, "Your asset selections have been finalized.");

      // Wait for 1 seconds before deleting the messages
      setTimeout(async () => {
        try {
          // Delete the confirmation message
          await bot.deleteMessage(chatId, confirmationMessage.message_id);
          // Delete the "Select your bots" message if the messageId is available
          if (messageId) {
            await bot.deleteMessage(chatId, messageId);
          }
        } catch (error) {
          console.error(`Failed to delete messages: ${error.message}`);
          // Handle the error, maybe inform the user or log the error
        }
      }, 1000); // 1000 milliseconds = 1 seconds

      // Optionally, call a function to handle post-selection logic here
    }
    // Handle the case when a user wants to go back to the main menu
    else if (data === 'back_to_menu') {
      await bot.deleteMessage(chatId, messageId);
      //await displayMainMenu(chatId);
    }
    // Handle the case when a user subscribes to a feed
    else if (data.startsWith('subscribe_')) {
      const feedName = data.split('_')[1];
      await handleSubscription(chatId, feedName);
    }
    // Handle the case when a user requests a token
    else if (data === 'request_token') {
      bot.sendMessage(chatId, "Please paste the Contract address below:");
      awaitingContractAddress.set(chatId, true);
    }

    else if (data === 'verify') {
      const msg = { chat: { id: chatId }, text: '/verify' };
      console.log(msg);
      await callback_verify(msg);  // Emit a 'message' event to trigger the /verify command
    }

    else if (data === 'trial') {
      const msg = { chat: { id: chatId }, text: '/trial' };
      const match = [] ;
      await callback_trial(msg, match)  // Emit a 'message' event to trigger the /trial command
    }

    // Handle the case when a user asks Referrals
    else if (data === 'referrals') {
      await showReferralMenu(chatId);
    }

    else if (data === 'tiers') {
      const msg = { chat: { id: chatId }, text: '/tiers' };
      await callback_tiers(msg);  // Emit a 'message' event to trigger the /tiers command
    } else if (data === 'docs') {
      const msg = { chat: { id: chatId }, text: '/docs' };
      await callback_doc(msg);  // Emit a 'message' event to trigger the /docs command
    } else if (data === 'socials') {
      const msg = { chat: { id: chatId }, text: '/socials' };
      await callback_social(msg);
    }

    // Handle the case when a user needs to upgrade their tier
    else if (data === 'upgrade_required') {
      sendUpgradePrompt(chatId);
    }
    // Handle user agreement or disagreement to terms and conditions
    else if (data === 'agree' || data === 'disagree') {
      if (data === 'agree') {
        await handleUserAgreement(chatId);
      } else {
        bot.sendMessage(chatId, 'To use our services, agreeing to the terms and conditions is required. If you have any questions or concerns, please reach out to us via the official channels.');
      }
    }

    else if (data === "agree_for_trial" || data === "disagree_for_trial") {
      if (data === "agree_for_trial") {
        await followJesterBot(chatId);
      }
      else {
        bot.sendMessage(chatId, "To use our services, agreeing to the terms and conditions is required. If you have anyquestions or concerns, please reach out to us via the official channels.");
      }
    }

    // Handle user agreement or disagreement to send another wallet for verification.
    else if ((data === 'another_wallet_agree' || data === 'another_wallet_disagree') && awaitingVerification.has(chatId)) {
      console.log(chatId);
      if (data === 'another_wallet_agree') {
        await handleMultiVerification(chatId);
      } else {
        await handleUserVerification(chatId);
      }
    }
    else if (data === '/docs') {
      bot.sendMessage(chatId, 'For comprehensive guidance on utilizing JesterBot, visit our documentation at [JesterBot Documentation](https://jesterbot.gitbook.io/jesterbot/).', { parse_mode: 'Markdown' });
    }
    else if (data === 'register_tradingID') {
      awaitingAction.set(chatId, "register_tradingID");
      bot.sendMessage(chatId, "Register your TradingView ID");
    }
    else if (data == 'register_twitt_ID') {
      awaitingPostTweet.set(chatId, true);
      bot.sendMessage(chatId, "Please paste the tweet URL below:");
    }
    else if (data === 'register_tradingID_accept') {
      bot.sendMessage(chatId, "⚠️ Tradingview ID received, please allow up to 48 hours for access");
      await awaitingRegisterTradingID(chatId, registerTradingId.get(chatId));
      awaitingAction.set(chatId, "idle");
    }
    else if (data === 'register_tradingID_cancel') {
      bot.deleteMessage(chatId, messageId);
      awaitingAction.set(chatId, "idle");
    }
  } catch (error) {
    console.error(`Error handling callback query for chatId ${chatId}: ${error.message}`);
    bot.sendMessage(chatId, "There was an error processing your request. Please try again later.");
  }

  // Always remember to answer callback queries
  bot.answerCallbackQuery(callbackQuery.id);
});

async function retrieveFeeds() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM feeds", (err, rows) => {
      if (err) {
        console.error("Error retrieving feeds:", err);
        reject(err);
      } else {
        console.log("Retrieved feeds:", rows);
        resolve(rows.recordset);
      }
    });
  });
}

async function displayFeedSettings(chatId, messageId) {
  const feeds = await retrieveFeeds();
  const inlineKeyboard = feeds.map((feed) => {
    return [
      {
        text: `${feed.display_name}`,
        callback_data: `toggle_setting_feed_${feed.feed_name}`
      }
    ]
  })
  inlineKeyboard.push([
    {
      text: '🔙 Back to Menu',
      callback_data: 'back_to_menu'
    }
  ]);
  const opts = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: inlineKeyboard }
  };
  await bot.sendMessage(chatId, "Manage your feed settings", opts);
}

async function displaySettingForFeed(chatId, messageId, feedName) {
  displayFeedOptions(chatId, messageId, feedName);
}

async function displayFeedOptions(chatId, messageId, feedName) {
  console.log(`Attempting to edit message with chatId: ${chatId} and messageId: ${messageId}`);
  // Fetch the user's current feed subscriptions from the database
  const currentSubscriptions = await getUserSubscribedFeeds(chatId);
  console.log(`Current subscriptions for chatId ${chatId}:`, currentSubscriptions); // Log current subscriptions
  // Create the inline keyboard with toggle buttons
  console.log(`current feed name is ${feedName}`);
  const inlineKeyboard = [];
  const feeds = await retrieveFeeds();
  await addUserAsset(chatId, feedName);
  feeds.map((feed) => {
    if (feed.feed_name == feedName) {
      const isSelected = currentSubscriptions.includes(feed.feed_name); // Check if the feed is selected
      inlineKeyboard.push([
        {
          text: `${feed.display_name} ${isSelected ? '| ✅' : '| ❌'}`,
          callback_data: `toggle_feed_${feed.feed_name}`
        }
      ]);
    }
  });

  // If user is subscribed to 'eth', add the bot selection option
  if (currentSubscriptions.includes(feedName)) {
    inlineKeyboard.push([
      {
        text: '🤖 Select Preferred Interface',
        callback_data: `toggle_bot_${feedName},`
      }
    ]);
  }

  if (currentSubscriptions.includes(feedName)) {
    inlineKeyboard.push([
      {
        text: '✨ Enable Assets',
        callback_data: `enable_asset_${feedName}`
      }
    ]);

    const status = await getAlertStatus(chatId, feedName);
    inlineKeyboard.push([
      {
        text: `${!status ? "🔕" : "🔔"} ${!status ? "All assets disabled" : "All assets enabled"}`,
        callback_data: `alert_on_${feedName}`
      }
    ]);
  }

  // Add a 'Back to Menu' button
  inlineKeyboard.push([
    {
      text: '🔙 Back to Menu',
      callback_data: 'back_to_menu'
    }
  ]);

  // Prepare the options for sending/editing the message
  const opts = {
    chat_id: chatId,
    reply_markup: { inline_keyboard: inlineKeyboard }
  };

  // Edit the original message with the new inline keyboard
  console.log(messageId);
  try {
    console.log(`Editing message with options: ${JSON.stringify(opts)}`);
    if (messageId) {
      console.log("------------------------------------------------------------------------");
      opts.message_id = messageId;
      await bot.editMessageText('Manage your feed subscriptions:', opts);
    }
    else
      await bot.sendMessage(chatId, 'Manage your feed subscriptions:', opts);
  } catch (error) {
    const bots = await retrieveBots();
    console.error(`Failed to edit the message: ${error.message}`);
    // Optionally inform the user that there was an error
  }
}

async function getAlertStatus(chatId, feedName) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT alert FROM user_assets WHERE chatId = '${chatId}' AND feed = '${feedName}'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching alert status: ${err.message}`);
        reject(err);
      } else {
        if (rows.recordset[0])
          resolve(rows.recordset[0].alert);
        else resolve(false);
      }
    });
  });
}

async function toggleAlertFeed(chatId, feedName) {
  const status = !(await getAlertStatus(chatId, feedName));
  await enableAllAssets(chatId, feedName, status);
  return new Promise((resolve, reject) => {
    db.run(`UPDATE user_assets SET alert = '${status}' WHERE chatId = '${chatId}' AND feed = '${feedName}'`, function (err) {
      if (err) {
        console.error(`Error updating user's assets alert status: ${err.message}`);
        reject(err);
      } else {
        resolve(this.changes > 0); // returns true if the subscription was updated
      }
    });
  });
}

async function toggleAlertStatus(chatId, messageId, feedName) {
  await toggleAlertFeed(chatId, feedName);
  await displaySettingForFeed(chatId, messageId, feedName);
}

// Function to retrieve all feeds a user is subscribed to
async function getUserSubscribedFeeds(chatId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT feed_name FROM subscriptions WHERE chat_id = '${chatId}'`, (err, rows) => {
      if (err) {
        console.error(`Error when fetching subscribed feeds: ${err.message}`);
        reject(err);
      } else {
        const feedNames = rows.recordset.map(row => row.feed_name);
        console.log(`Subscribed feeds for chatId ${chatId}:`, feedNames);
        resolve(feedNames.length > 0 ? feedNames : []);
      }
    });
  });
}

async function removeWalletFromDB(chatId, wallet) {
  if (wallet != "all")
    return new Promise((resolve, reject) => {
      db.all(`DELETE FROM user_verification WHERE chat_id = '${chatId}' AND wallet_address = '${wallet}'`, (err, rows) => {
        if (err) {
          console.error(`Error when deleting ${wallet}: ${err.message}`);
          reject(err);
        } else {
          console.log(`Successfully removed`);
          bot.sendMessage(chatId, `${getReducedWalletAddress(wallet)} has been successfully removed.`);
          updateUserTiersHourly();
          resolve(true);
        }
      });
    });
  return new Promise((resolve, reject) => {
    db.all(`DELETE FROM user_verification WHERE chat_id = '${chatId}' AND wallet_address != '${"Trial" + chatId}'`, (err, rows) => {
      if (err) {
        console.error(`Error when deleting ${wallet}: ${err.message}`);
        reject(err);
      } else {
        console.log(`Successfully removed`);
        bot.sendMessage(chatId, `All wallets have been successfully removed.`);
        updateUserTiersHourly();
        resolve(true);
      }
    });
  });
}

// Function to check if the user is already subscribed to the feed
async function isUserAlreadySubscribed(chatId, feedName) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id FROM subscriptions WHERE chat_id = '${chatId}' AND feed_name = '${feedName}'`, (err, row) => {
      if (err) {
        console.error(`Error checking if user is already subscribed: ${err.message}`);
        reject(err);
      } else {
        resolve(!!row.recordset[0]); // resolve with true if row exists (user is subscribed)
      }
    });
  });
}

async function toggleSubscription(chatId, feedName, messageId) {
  let bots;
  let currentSelections;

  try {
    const userStatus = await getUserVerificationStatus(chatId);
    if (!userStatus || userStatus.tier === "Unverified") {
      await bot.sendMessage(chatId, "You need to be verified and have the appropriate tier to manage this feed subscription.");
      return;
    }

    // const restrictedFeeds = { 
    //   'axe' : ['The Clown', 'The Harlequin'],
    // };
    // if (restrictedFeeds[feedName] && !restrictedFeeds[feedName].includes(userStatus.tier)) {
    //   await bot.sendMessage(chatId, `The ${feedMapping[feedName] || feedName} feed is not available for your tier: ${userStatus.tier}.`);
    //   return;
    // }

    const isSubscribed = await isUserAlreadySubscribed(chatId, feedName);
    const feeds = await retrieveFeeds();
    if (isSubscribed) {
      await unsubscribeUser(chatId, feedName);
      // Send confirmation message with emoji version
      const curFeed = feeds.filter(feed => feed.feed_name == feedName)[0];
      bot.sendMessage(chatId, `You have unsubscribed from the ${curFeed.display_name || curFeed.feed_name} feed.`);
    } else {
      await subscribeUser(chatId, feedName);
      // Send confirmation message with emoji version
      const curFeed = feeds.filter(feed => feed.feed_name == feedName)[0];
      bot.sendMessage(chatId, `You are now subscribed to the ${curFeed.display_name || curFeed.feed_name} feed.`);
      // if (feedName === 'eth') {
      //   const bots = await retrieveBots(); // Retrieve bots here
      //   const currentSelections = await getUserBotSelections(chatId); // Retrieve current selections here
      //   await displayBotOptions(chatId, null, currentSelections, bots); // Pass them to displayBotOptions
      // } 
    }
  } catch (error) {
    console.error(`Error handling subscription toggle: ${error}`);
    await bot.sendMessage(chatId, "There was an error processing the subscription request. Please try again later.");
  }
  await displayBotOptions(chatId, messageId, currentSelections, bots, feedName);
}


async function updateUserPreferredBot(chatId, botSimpleName) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE subscriptions SET preferred_bot = '${botSimpleName}' WHERE chat_id = '${chatId}' AND feed_name = 'eth'`, function (err) {
      if (err) {
        console.error(`Error updating user's preferred bot: ${err.message}`);
        reject(err);
      } else {
        resolve(this.changes > 0); // returns true if the subscription was updated
      }
    });
  });
}

async function displayAssetOptions(chatId, messageIdToDelete, currentSelections, assets, feedName) {
  console.log(`Displaying asset options for chatId: ${chatId}`);
  console.log(`MessageIdToDelete: ${messageIdToDelete}`);
  console.log(`Current selections: ${JSON.stringify(currentSelections)}`);
  console.log(`Assets array: ${JSON.stringify(assets)}`);

  if (!currentSelections || !assets) {
    console.error(`Invalid input for displayAssetOptions: currentSelections or assets are undefined`);
    return;
  }

  // Prepare the inline keyboard
  const inlineKeyboard = assets.map(asset => {
    const isSelected = currentSelections.includes(asset.name.slice(0, 10));
    console.log(`asset: ${asset.name}, Name: ${asset.name}, Is Selected: ${isSelected}`);
    return [{
      text: `${asset.name} ${isSelected ? '| ✅' : '| ❌'}`,
      callback_data: `toggle_asset_${feedName},${validator.escape(asset.name.slice(0, 10))}`
    }];
  });

  // Add the finalize button
  inlineKeyboard.push([{
    text: '✔️ Finalize Selection',
    callback_data: 'finalize_assets'
  }]);

  // Message options
  const opts = {
    chat_id: chatId,
    reply_markup: { inline_keyboard: inlineKeyboard }
  };

  // Attempt to edit or send a new message based on messageIdToDelete
  try {
    if (messageIdToDelete) {
      console.log(`Attempting to edit message with ID: ${messageIdToDelete}`);
      await bot.editMessageText('Select your assets:', {
        ...opts,
        message_id: messageIdToDelete
      });
      console.log(`Edited message successfully for chatId: ${chatId}`);
    } else {
      console.log(`No messageIdToDelete provided, sending new message for chatId: ${chatId}`);
      await bot.sendMessage(chatId, 'Select your assets:', opts);
    }
  } catch (error) {
    console.error(`Failed to display asset options for chatId ${chatId}: ${error.message}`);
    // Additional error handling or notification to user can be added here
  }
}

async function displayBotOptions(chatId, messageIdToDelete, currentSelections, bots, feedName) {
  console.log(`Displaying bot options for chatId: ${chatId}`);
  console.log(`MessageIdToDelete: ${messageIdToDelete}`);
  console.log(`Current selections: ${JSON.stringify(currentSelections)}`);
  console.log(`Bots array: ${JSON.stringify(bots)}`);

  // Ensure bots is defined and has content
  if (!bots || bots.length === 0) {
    bots = await retrieveBots();
  }

  if (!currentSelections || !bots) {
    console.error(`Invalid input for displayBotOptions: currentSelections or bots are undefined`);
    return;
  }

  // Prepare the inline keyboard
  const inlineKeyboard = bots.filter(bot => bot.support.indexOf(feedName) >= 0).map(bot => {
    const isSelected = currentSelections.includes(bot.simpleName);
    console.log(`Bot: ${bot.name}, SimpleName: ${bot.simpleName}, Is Selected: ${isSelected}`);
    return [{
      text: `${bot.name} ${isSelected ? '| ✅' : '| ❌'}`,
      callback_data: `toggle_bot_${validator.escape(feedName)},${validator.escape(bot.simpleName)}`
    }];
  });

  // Add the finalize button
  inlineKeyboard.push([{
    text: '✔️ Finalize Selection',
    callback_data: 'finalize_bots'
  }]);

  // Message options
  const opts = {
    chat_id: chatId,
    reply_markup: { inline_keyboard: inlineKeyboard }
  };

  // Attempt to edit or send a new message based on messageIdToDelete
  try {
    if (messageIdToDelete) {
      console.log(`Attempting to edit message with ID: ${messageIdToDelete}`);
      await bot.editMessageText('Select your bots:', {
        ...opts,
        message_id: messageIdToDelete
      });
      console.log(`Edited message successfully for chatId: ${chatId}`);
    } else {
      console.log(`No messageIdToDelete provided, sending new message for chatId: ${chatId}`);
      await bot.sendMessage(chatId, 'Select your bots:', opts);
    }
  } catch (error) {
    console.error(`Failed to display bot options for chatId ${chatId}: ${error.message}`);
    // Additional error handling or notification to user can be added here
  }
}



// Fetch the user's current bot selections
async function getUserBotSelections(chatId, feedName) {
  return new Promise((resolve, reject) => {
    // Modify the query to handle cases where preferred_bot might be null or empty
    db.all(`SELECT preferred_bot FROM subscriptions WHERE chat_id = '${chatId}' AND feed_name = '${feedName}'`, (err, row) => {
      if (err) {
        console.error(`Error when fetching user bot selections: ${err.message}`);
        reject(err);
      } else if (row && row.recordset[0] && row.recordset[0].preferred_bot) {
        // Split the string into an array if it's not empty
        const selections = row.recordset[0].preferred_bot.split(',');
        resolve(selections);
      } else {
        // Resolve with an empty array if there are no preferred bots
        resolve([]);
      }
    });
  });
}

async function getUserAssetSelections(chatId, feedName) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT assets, alert FROM user_assets WHERE chatId = '${chatId}' AND feed = '${feedName}'`, (err, row) => {
      if (err) {
        console.error(`Error when fetching user assets for feed ${feedName}`);
        reject(err);
      }
      else {
        console.log("UserAssets:  ", row.recordset[0]);
        if (row.recordset[0] == undefined || !row.recordset[0].assets)
          resolve({ assets: "", alert: 0 });
        else
          resolve(row.recordset[0]);
      }
    })
  })
}

async function awaitingRemovePanel(chatId) {
  bot.sendMessage(chatId, "⚠️ If you select default wallet, all associated wallets will be removed.");
  const wallets = await getUserWallets(chatId);
  console.log(`current wallets: ${wallets}`);
  const inlineKeyboard = wallets.filter(wa => wa.wallet_address != `${"Trial" + chatId}`).map(wallet => {
    console.log(`${getReducedWalletAddress(wallet.wallet_address)} {${wallet.tier == "none" ? "" : `(default)`}}`);
    return [{
      text: `${getReducedWalletAddress(wallet.wallet_address)} ${wallet.tier == "none" ? "" : `(default)`}`,
      callback_data: `toggle_remove_wallet_${validator.escape(wallet.wallet_address)}`
    }];
  });
  const opts = {
    chat_id: chatId,
    reply_markup: { inline_keyboard: inlineKeyboard }
  };
  bot.sendMessage(chatId, "Select a wallet to remove", opts);
}

async function enableAllAssets(chatId, feedName, enable) {
  const allAssets = await retrieveAssets(feedName);
  console.log(allAssets);
  const updatedSelections = allAssets.map(asset => asset.name.slice(0, 10)).join(',');
  if (enable)
    await updateUserAssetSelections(chatId, feedName, updatedSelections);
  else
    await updateUserAssetSelections(chatId, feedName, "");
}

async function toggleAssetSelection(chatId, asset, messageIdToDelete, assets, feedName) {
  let currentSelections = (await getUserAssetSelections(chatId, feedName)).assets.split(',');
  currentSelections = currentSelections.map(item => item.slice(0, 10));
  console.log(`Feed: ${feedName} :  Asset: ${asset}`);

  const updatedSelections = currentSelections.includes(asset) ? currentSelections.filter(name => name !== asset)
    : [...currentSelections, asset.slice(0, 10)].filter(name => name.trim() !== '');

  console.log(`updated Selections: ${updatedSelections}`);

  try {
    await updateUserAssetSelections(chatId, feedName, updatedSelections);
    await displayAssetOptions(chatId, messageIdToDelete, updatedSelections, assets, feedName);
  }
  catch (err) {
    console.log(err);
  }
}

async function toggleBotSelection(chatId, botSimpleName, messageIdToDelete, bots, feedName) {
  console.log(`Toggling bot selection for chatId: ${chatId}, botSimpleName: ${botSimpleName}, messageIdToDelete: ${messageIdToDelete}`);

  // Fetch bots and current selections
  const currentSelections = await getUserBotSelections(chatId, feedName);
  console.log(`Current bot selections before update: ${currentSelections}`);

  // Determine if the bot is currently selected
  const isCurrentlySelected = currentSelections.includes(botSimpleName);
  let updatedSelections = isCurrentlySelected
    ? currentSelections.filter(simpleName => simpleName !== botSimpleName)
    : [...currentSelections, botSimpleName].filter(simpleName => simpleName.trim() !== '');
  console.log(`Updated selections for chatId ${chatId}: ${updatedSelections}`);

  // Update the database with the new selections
  try {
    await updateUserBotSelections(chatId, updatedSelections, feedName);
    console.log(`Bot selection updated for chatId ${chatId}`);
    await displayBotOptions(chatId, messageIdToDelete, updatedSelections, bots, feedName);
  } catch (error) {
    console.error(`Error updating bot selection for chatId ${chatId}: ${error.message}`);
    // Additional error handling or notification to user can be added here
  }
}

let awaitingConfirmToRemove = new Map();

async function confirmWalletToRemove(chatId, wallet) {
  const cur = await getUserVerificationStatus(chatId);
  awaitingConfirmToRemove.set(chatId, "all");
  if (wallet != cur.wallet_address)
    awaitingConfirmToRemove.set(chatId, wallet);
  bot.sendMessage(chatId, `Confirm wallet to remove: (${getReducedWalletAddress(wallet)})` + "\n\n" + "To confirm remove wallet, input first 5 letters of wallet address. e.g 0x3fewa");
}

async function updateUserBotSelections(chatId, newSelections, feedName) {
  return new Promise((resolve, reject) => {
    const selectionsString = newSelections.join(',');
    db.run(`UPDATE subscriptions SET preferred_bot = '${selectionsString}' WHERE chat_id = '${chatId}' AND feed_name = '${feedName}'`, function (err) {
      if (err) {
        console.error(`Error updating user bot preferences: ${err.message}`);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function updateUserAssetSelections(chatId, feedName, updatedItem) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE user_assets SET assets = '${updatedItem}' WHERE chatId ='${chatId}' AND feed = '${feedName}'`, function (err) {
      if (err) {
        console.error(`Error updating user asset preferences: ${err.message}`);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// Function to subscribe a user to a feed
async function subscribeUser(chatId, feedName) {
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO subscriptions (chat_id, feed_name)
      SELECT '${chatId}', '${feedName}'
      WHERE NOT EXISTS (
        SELECT 1
        FROM subscriptions
        WHERE chat_id = '${chatId}' And feed_name = '${feedName}'
      )
    `, function (err) {
      if (err) {
        console.error(`Error subscribing user to feed: ${err.message}`);
        reject(err);
      } else {
        resolve(this.changes > 0); // returns true if the subscription was added
      }
    });
  });
}

// Function to subscribe a user to a feed
async function addUserAsset(chatId, feedName) {
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO user_assets (chatId, feed)
      SELECT '${chatId}', '${feedName}'
      WHERE NOT EXISTS (
        SELECT 1
        FROM user_assets
        WHERE chatId = '${chatId}' And feed = '${feedName}'
      )
    `, function (err) {
      if (err) {
        console.error(`Error adding user asset to user_assets: ${err.message}`);
        reject(err);
      } else {
        resolve(this.changes > 0); // returns true if the subscription was added
      }
    });
  });
}

// Function to unsubscribe a user from a feed
async function unsubscribeUser(chatId, feedName) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM subscriptions WHERE chat_id = '${chatId}' AND feed_name = '${feedName}'`, function (err) {
      if (err) {
        console.error(`Error unsubscribing user from feed: ${err.message}`);
        reject(err);
      } else {
        resolve(this.changes > 0); // returns true if the subscription was removed
      }
    });
  });
}

//REMAINING COMMANDS
const callback_tiers = (msg) => {
  const chatId = msg.chat.id;
  clearAwaitingValues(chatId);

  bot.sendMessage(chatId, 'Starter: 2500 $JEST\n' +
    'Standard: 5000 $JEST\n' +
    'Premium: 10000 $JEST\n' +
    'For a detailed breakdown of the features and benefits each tier offers, please see our [Tiers](https://jester.global/pricing).', { parse_mode: 'Markdown', disable_web_page_preview: true });
}
bot.onText(/\/tiers/, callback_tiers);

const callback_doc = (msg) => {
  const chatId = msg.chat.id;
  clearAwaitingValues(chatId);

  bot.sendMessage(chatId, 'For comprehensive guidance on utilizing JesterBot, additional background information, FAQs, and to review our Terms and Conditions, please visit our documentation at [JesterBot Documentation](https://jesterbot.gitbook.io/jesterbot/).', { parse_mode: 'Markdown', disable_web_page_preview: true });
}
bot.onText(/\/docs/, callback_doc);

const callback_social = (msg) => {
  const chatId = msg.chat.id;
  clearAwaitingValues(chatId);

  bot.sendMessage(chatId, '[Linktree](https://linktr.ee/JestTech)', { parse_mode: 'Markdown', disable_web_page_preview: true });
}
bot.onText(/\/socials/, callback_social);

async function getSubscribedUsers(feedName) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT chat_id FROM subscriptions WHERE feed_name = '${feedName}'`, (err, rows) => {
      if (err) {
        console.error(`Error fetching subscribed chat IDs for feed '${feedName}': ${err.message}`);
        reject(err);
      } else {
        const chatIds = rows.recordset.map(row => row.chat_id);
        console.log(`Found subscribed chat IDs for feed '${feedName}':`, chatIds);
        resolve(chatIds);
      }
    });
  });
}

async function buildInlineKeyboardForFeed(feedType, signalInfo, chatId) {
  let inlineKeyboard;
  console.log(`Building inline keyboard for feed type: ${feedType} and chatId: ${chatId}`);

  // Retrieve the full list of bots from the database
  const bots = await retrieveBots();
  console.log(`Full bots array:`, JSON.stringify(bots, null, 2));

  // Fetch user's preferred bots
  const userBots = await getUserBotSelections(chatId, feedType);
  console.log(`Fetched user's preferred bots for chatId ${chatId}:`, userBots);

  // Map the simpleName to bot objects
  const userBotObjects = userBots.map(simpleName => {
    return bots.find(bot => bot.simpleName === simpleName);
  }).filter(bot => bot); // Filter out undefined entries

  console.log(`User bot objects after mapping:`, userBotObjects);

  if (userBotObjects.length > 0) {
    console.log("Using user-selected bot keyboard.");
    inlineKeyboard = userBotObjects.map(bot => {
      let comm = bot.command;
      comm = comm.replace(/\${signalInfo\.contractAddress}/g, signalInfo.contractAddress)
      return [{
        text: bot.name,
        url: `${comm}`
      }];
    });
  } else {
    console.log(`No match for feed type: ${feedType}, using a default empty keyboard.`);
    inlineKeyboard = []; // Default case if no feed type matches
  }

  console.log(`Inline keyboard for feed '${feedType}':`, inlineKeyboard);
  return { inline_keyboard: inlineKeyboard };
}

async function getFeedData(feedName) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT display_name, chart, scanner FROM Feeds WHERE feed_name = '${feedName}'`, (err, rows) => {
      if (err) {
        console.error(`Error getting charts for feed ${feedName}:`, err);
        reject(err);
      } else {
        console.log(`get chart for feed ${feedName}:`, rows);
        resolve(rows.recordset[0]);
      }
    });
  });
}

async function formatSignalMessage(signalInfo, feedName) {
  const nowUTC = new Date();
  const hours = nowUTC.getUTCHours().toString().padStart(2, '0'); // Add leading zero if needed
  const minutes = nowUTC.getUTCMinutes().toString().padStart(2, '0'); // Add leading zero if needed
  const formattedTime = `${hours}:${minutes} UTC`; // Format as "HH:MM UTC"
  // Define different emojis for buy and sell signals for clear distinction
  const buyEmoji = '🟢'; // Green circle for BUY
  const sellEmoji = '🔴'; // Red circle for SELL
  const biasEmoji = signalInfo.bias.toUpperCase() === 'BUY' ? buyEmoji : sellEmoji;
  const actionText = signalInfo.bias.toUpperCase() === 'BUY' ? 'BUY SIGNAL' : 'SELL SIGNAL';
  let { display_name, chart, scanner } = await getFeedData(feedName.toLowerCase());
  chart = chart.replace(/\${signalInfo\.contractAddress}/g, signalInfo.contractAddress);
  if (scanner)
    scanner = scanner.replace(/\${signalInfo\.contractAddress}/g, signalInfo.contractAddress);

  return `${biasEmoji} ${actionText} ${biasEmoji}\n
  <b> ${display_name} </b>
  <b>${signalInfo.name}</b>
  ${signalInfo.contractAddress ? `<b>⚙️:</b> <code>${getReducedWalletAddress(signalInfo.contractAddress)}</code>` : ""}
  <b>📊:</b> ${chart}
  ${scanner ? `<b>🔎:</b> ${scanner}` : ''} 
  -----------------------------
  <b>💲:</b> <code>${signalInfo.price}</code>` +
    `${signalInfo.sl ? `\n  <b>🛑:</b> <code>${signalInfo.sl}</code>` : ""}` +
    `${signalInfo.tp1 ? `\n  <b>💰:</b> <code>${signalInfo.tp1}</code>` : ""}` +
    `${signalInfo.tp2 ? `\n  <b>💰:</b> <code>${signalInfo.tp2}</code>` : ""}` +
    `\n  <b>🕓:</b> ${formattedTime}`;
}

async function handleNewSignal(signalData) {
  // Extract necessary data from the signal
  const contractAddress = signalData.contractAddress;
  const signalTime = new Date(); // Current time, or extract from signal if available
  const direction = signalData.direction; // 'BUY' or 'SELL'
  const price = signalData.price;

  // Insert data into the database
  db.run(`INSERT INTO trade_signals (contract_address, signal_time, direction, price) VALUES ('${contractAddress}', '${signalTime}', '${direction}', '${price}')`, function (err) {
    if (err) {
      console.error(`Error inserting trade signal: ${err.message}`);
      // Handle error 
    } else {
      console.log(`Trade signal inserted with ID: ${this.lastID}`);
      // Further processing if needed
    }
  });
}

//record signal   
function insertSignalHistory(signalInfo) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO signal_history (name, contract_address, price, time, bias) VALUES ('${signalInfo.name}', '${signalInfo.contractAddress}', '${signalInfo.price}', '${signalInfo.time}', '${signalInfo.bias}')`, function (err) {
      if (err) {
        console.error('Error inserting signal into database:', err.message);
        reject(err);
      } else {
        console.log(`Signal history added with ID: ${this.lastID}`);
        resolve(this.lastID);
      }
    });
  });
}

async function getFeedForAsset(name) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT feed FROM feed_assets WHERE name = '${name}'`, (err, rows) => {
      if (err) {
        console.error("Error to get feeds for asset:", err);
        reject(err);
      } else {
        console.log("Feeds for asset:", rows);
        resolve(rows.recordset[0].feed);
      }
    });
  });
}

async function loginWithRef(refUser, chatId) {
  console.log("startwith,   ", refUser);
  const ref_chatId = await getChatIdFromRef(refUser);
  console.log(ref_chatId);
  if (chatId == null) {
    console.log("Cannot access with current account!");
    return;
  }

  // Update followers for refer account
  await updateFollowers(chatId, ref_chatId);
}

async function processSignal(signalInfo) {
  let supportedFeeds = (await getFeedForAsset(signalInfo.name)).replace(" ", "").split(',');
  supportedFeeds.map(async (feedName) => {
    console.log(`Processing signal for feed type '${feedName}'.`);

    // Define the chat ID of the group where ETH mainnet calls should be sent
    const subscribedUsers = await getSubscribedUsers(feedName);
    console.log(`Subscribed users for feed '${feedName}':`, subscribedUsers);

    for (const chatId of subscribedUsers) {
      console.log(`Processing signal for chatId: ${chatId}`);
      const selections = (await getUserAssetSelections(chatId, feedName)).assets.split(',');
      console.log(selections);
      if (selections.includes(signalInfo.name.slice(0, 10))) {
        let message = await formatSignalMessage(signalInfo, feedName);
        const inlineKeyboard = await buildInlineKeyboardForFeed(feedName, signalInfo, chatId);
        try {
          await insertSignalHistory(signalInfo);
          await bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: inlineKeyboard,
          });
          console.log(`Signal message sent to chatId ${chatId}`);
        } catch (error) {
          console.error(`Failed to send message to chatId ${chatId}:`, error);
        }
      }
    }
  });
}

module.exports = { processSignal, verifyWithTweet };
