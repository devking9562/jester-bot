require('dotenv').config();

let dbConfig = {
     user: process.env.user,
     password: process.env.password,
     server: process.env.server,
     database: process.env.database,
     options: {
       encrypt: true, // For secure connection
       trustServerCertificate: true, // Change to false if not using a trusted certificate
       collation: 'SQL_Latin1_General_CP1_CI_AS',
       charset: 'utf8mb4',
     }
};

if(process.env.mode == "test"){
  dbConfig = {
    user: process.env.test_user,
    password: process.env.test_password,
    server: process.env.test_server,
    database: process.env.test_database,
    options: {
      encrypt: true, // For secure connection
      trustServerCertificate: true, // Change to false if not using a trusted certificate
      collation: 'SQL_Latin1_General_CP1_CI_AS',
      charset: 'utf8mb4',
    }
};
}

module.exports = {dbConfig};