#!/bin/bash
git pull origin main
docker stop LeaderProductAPI
docker rm LeaderProductAPI
docker build --no-cache -t your-api-image .
docker run -d -p 3000:3000 --env-file .env --name LeaderProductAPI leader_api_image