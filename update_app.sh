#!/bin/bash
cd /path/to/your/app
git pull
npm install
pm2 restart my-express-app
