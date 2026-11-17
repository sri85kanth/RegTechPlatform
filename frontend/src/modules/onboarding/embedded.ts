import { createContext, useContext } from 'react';

/**
 * True when a page is rendered as a tab of another page (Add data) that already
 * draws the header. The page then skips its own <Topbar>, so there are never two
 * app bars stacked on one screen.
 */
export const EmbeddedPage = createContext(false);
export const useEmbedded = () => useContext(EmbeddedPage);
