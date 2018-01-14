while :
do
	killall ffmpeg
	killall node
    node index.js
    sleep 2
done
