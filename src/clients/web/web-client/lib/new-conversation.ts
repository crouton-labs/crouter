/**
 * The single entry point every "new chat" affordance routes through (design
 * R2): land on the conversations home with the composer open. The home page
 * reads the `?new` flag, opens the focused composer, and clears the flag. One
 * helper keeps the dock button, the icon rail, the Studio top-bar `+`, and the
 * global keybind behaviourally identical.
 */

import type { NavigateFunction } from 'react-router-dom';

export function startNewConversation(navigate: NavigateFunction): void {
  navigate('/?new=1');
}
