import { executeApiCall, isApiCallMessage, markAsBackgroundContext } from '../src/api/client';
import { getSettings } from '../src/lib/settings';

export default defineBackground(() => {
  markAsBackgroundContext();

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (isApiCallMessage(message)) {
      return getSettings().then((settings) =>
        executeApiCall(settings, message.path, message.init),
      );
    }
    return undefined;
  });
});
