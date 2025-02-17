import React, { useRef, useEffect } from 'react';

interface VideoStreamProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  stream: MediaStream;
  muted?: boolean;
}

const VideoStream: React.FC<VideoStreamProps> = React.memo(
  ({ stream, muted = false, ...props }) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
      }
    }, [stream]);

    return (
      <video ref={videoRef} autoPlay playsInline muted={muted} {...props} />
    );
  }
);

VideoStream.displayName = 'VideoStream';

export default VideoStream;
