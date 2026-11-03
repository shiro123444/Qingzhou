import { Navigate, useParams } from 'react-router-dom';

import { channelPath, isChannelPlatform } from '../constants';

export default function ChannelProviderRedirect() {
  const { platform, providerId } = useParams();
  return (
    <Navigate
      replace
      to={
        isChannelPlatform(platform) && providerId ? channelPath(platform, providerId) : '/channels'
      }
    />
  );
}
