// Explicitly disconnected integration: do not expose as an HTTP route until the
// private media service, authentication, limits and storage are implemented.
import {transformAndVerifyVideo} from './media-binding.mjs';
import {inspectMp4} from './mp4-inspect.mjs';
export function createVideoPreparer(media) {
 if(!media || typeof media.input!=='function')throw Error('Cloudflare media binding unavailable');
 return async ({input,mime,durationSeconds,startSeconds=0,keepSound,signal,captureRejected=false})=>transformAndVerifyVideo({media,input,mime,durationSeconds,startSeconds,keepSound,signal,captureRejected,inspect:async bytes=>inspectMp4(bytes)});
}
