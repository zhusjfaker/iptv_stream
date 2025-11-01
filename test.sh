#!/bin/sh

# ffmpeg -i "http://192.168.5.1:4022/udp/228.1.1.28:8008" \
#   -c copy -f hls -hls_time 5 -hls_list_size 5 ./output/cctv1.m3u8

ffmpeg -i http://192.168.5.1:4022/udp/228.1.1.28:8008 -c copy -f hls -hls_time 5 -hls_list_size 5 -hls_flags delete_segments -hls_segment_filename /Users/zhushijie/Desktop/github/iptv_stream/output/CCTV1_%03d.ts /Users/zhushijie/Desktop/github/iptv_stream/output/CCTV1.m3u8