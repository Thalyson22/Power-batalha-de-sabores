import { handlePoll } from '../lib/poll-server.js';

export default {
  fetch(request) {
    return handlePoll(request);
  }
};
