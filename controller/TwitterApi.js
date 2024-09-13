const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');

require('dotenv').config();

// Generate a code verifier and code challenge
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function exchangeCodeForToken(authCode, codeVerifier) {
    try {
        const requestBody = querystring.stringify({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            code: authCode,
            grant_type: 'authorization_code',
            redirect_uri: process.env.REDIRECT_URL,
            code_verifier: codeVerifier
        });

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64')}`
        };

        console.log('Exchanging authorization code for access token with request:');
        console.log('Headers:', headers);
        console.log('Request Body:', requestBody);

        const tokenResponse = await axios.post('https://api.twitter.com/2/oauth2/token', requestBody, { headers });
        return tokenResponse.data.access_token;
    } catch (error) {
        console.error('Error exchanging code for token:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
        });
        throw error;
    }
}

async function getTwitterData(url, accessToken, params = {}) {
    try {
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };

        console.log('Making GET request:', {
            url,
            headers,
            params
        });

        const response = await axios.get(url, { headers, params });
        return response.data;
    } catch (error) {
        console.error('Error fetching Twitter data:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
        });
        throw error;
    }
}

// Follow the account on behalf of the user
async function followAccount(targetAccountId, authorizedUserId, accessToken) {
    try {
        const url = `https://api.twitter.com/2/users/${authorizedUserId}/following`;
        const data = { target_user_id: targetAccountId };

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };

        console.log('Following account with request:', {
            url,
            headers,
            data
        });

        const response = await axios.post(url, data, { headers });
        return response.data;
    } catch (error) {
        console.error('Error following account:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
        });
        throw error;
    }
}

async function postTweet(post, accessToken) {
    try {
        const url = `https://api.twitter.com/2/tweet`;
        const data = { text: post };

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };

        console.log('Posting new tweet with request:', {
            url,
            headers,
            data
        });

        const response = await axios.post(url, data, { headers });
        return response.data;
    } catch (error) {
        console.error('Error following account:', {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data,
        });
        throw error;
    }
}

module.exports = {
    followAccount,
    exchangeCodeForToken,
    getTwitterData,
    generateCodeVerifier,
    generateCodeChallenge,
    postTweet
}