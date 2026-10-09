import { createContext, use } from 'react';
import { MESSAGES, type Messages } from '../i18n';

/** Current UI text for leaf components; pages receive `t` as a prop. */
export const MessagesContext = createContext<Messages>(MESSAGES.en);

export const useMessages = (): Messages => use(MessagesContext);
