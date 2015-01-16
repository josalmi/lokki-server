#!/bin/bash

DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )

REDISFILE="/tmp/redis";
APPFILE="/tmp/lokki";

[ -f "$APPFILE.pid" ] && kill $(cat "$APPFILE.pid") && rm -f "$APPFILE.pid";
[ -f "$REDISFILE.pid" ] && kill $(cat "$REDISFILE.pid") && rm -f "$REDISFILE.pid";


source "$DIR/port.sh";
REDISPORT=$(get_available_random_port); 
nohup redis-server "$DIR/redis.conf" --port "$REDISPORT" > /dev/null 2>&1 &
REDISPID=$!

APPPORT=$(get_available_random_port);
PORT="$APPPORT" REDISCLOUD_URL="redis://a:b@localhost:$REDISPORT" nohup node lokki-server.js > /dev/null 2>&1 &
APPPID=$!
echo -n "$REDISPID" > "$REDISFILE.pid"
echo -n "$REDISPORT" > "$REDISFILE.port"
echo -n "$APPPID" > "$APPFILE.pid"
echo -n "$APPPORT" > "$APPFILE.port"
sleep 1
