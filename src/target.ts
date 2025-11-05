import { embedded, rtc } from './target/config';
import connectRtc from './target/connectRtc';
import connectServer from './target/connectServer';
import connectIframe from './target/connectIframe';
import chobitsu from 'chobitsu';
import './target/consoleCapture';

if (!embedded) {
  if (rtc) {
    connectRtc();
  } else {
    connectServer();
  }
} else {
  connectIframe();
}

module.exports = {
  chobitsu,
};
