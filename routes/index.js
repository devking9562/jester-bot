const { processSignal, verifyWithTweet } = require('../Jester');
const { generateCodeVerifier, generateCodeChallenge, postTweet, getTwitterData, followAccount, exchangeCodeForToken } = require('../controller/TwitterApi');

const codeVerifier = generateCodeVerifier();
const codeChallenge = generateCodeChallenge(codeVerifier);
const scope = 'follows.write follows.read users.read tweet.read';
const targetAccountUsername = 'JestTech';
const state = 'random_string_to_prevent_csrf';
const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

module.exports = (app) => {
  app.use('/status', (req, res) => res.send('Status profile'));
  app.use('/users', (req, res) => res.send('User profile'));
  app.use('/verified/authorize', (req, res) => {
    console.log(process.env)
    const authUrl = `https://x.com/i/oauth2/authorize?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URL)}&scope=${encodeURIComponent(scope)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
    console.log('Redirecting to authorization URL:', authUrl);
    res.redirect(authUrl);
  })
  app.get('/verified', async (req, res) => {
    const authCode = req.query.code;
    console.log(req.query);
    try {
      // Exchange the authorization code for an access token
      accessToken = await exchangeCodeForToken(authCode, codeVerifier);
      console.log(`Access token retrieved successfully: ${accessToken.slice(0, 10)}...`);

      // Retrieve the authorized user's ID
      const userResponse = await getTwitterData('https://api.twitter.com/2/users/me', accessToken);
      const authorizedUserId = userResponse.data.id;
      console.log(userResponse.data);

      // Retrieve the user ID of "JestTech"
      const targetAccountResponse = await getTwitterData(`https://api.twitter.com/2/users/by/username/${targetAccountUsername}`, accessToken);
      if (!targetAccountResponse || !targetAccountResponse.data || !targetAccountResponse.data.id) {
        console.error(`Could not resolve the target account: ${targetAccountUsername}`);
        return res.status(500).send(`Could not resolve the target account: ${targetAccountUsername}`);
      }

      const targetAccountId = targetAccountResponse.data.id;
      console.log(`Target account ${targetAccountUsername} resolved to ID: ${targetAccountId}`);

      // Follow the account on behalf of the user
      const followResponse = await followAccount(targetAccountId, authorizedUserId, accessToken);
      console.log(followResponse);
      if (followResponse.data.following) {
        console.log('Successfully followed the target account.');
        await verifyWithTweet(userResponse.data.username);
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verified</title>
          <style>
            body { text-align: center; padding: 50px; }
            img { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>
          <h1>You have been verified!</h1>
          <p>Thank you for verifying. You will be redirected shortly...</p>
          <script>
            setTimeout(function() {
              window.location.href = "https://t.me/jestersignalsbot";
            }, 3000); // Redirect after 3 seconds
          </script>
        </body>
        </html>
      `);
      }
      else res.json("Authorization failed. Please try again");

      // res.json("Successfully authorized.");
    } catch (error) {
      console.error('Error following account:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });

      res.status(500).send(`Error following account: ${error.message}`);
    }
  });
  app.use('/tv-alert', async (req, res) => {
    try {
      const alertData = req.body;
      console.log('Received alert from TradingView:', alertData);

      // Process the alert data
      const signalInfo = {
        name: alertData.Name,
        pair: alertData.Pair,
        price: alertData.Price,
        time: alertData.Time,
        contractAddress: alertData.CA,
        type: alertData.Type,
        bias: alertData.Bias,
        sl: alertData.sl,
        tp1: alertData.tp1,
        tp2: alertData.tp2
      };

      // Call the processSignal function with the formatted signalInfo
      await processSignal(signalInfo);

      res.status(200).send('Alert processed successfully.');
    } catch (error) {
      console.error('Error in TradingView webhook:', error);
      res.status(500).send('Internal Server Error');
    }
  });
  app.use('*', (req, res) => {
    res.send('Not found!!!');
  });
};
