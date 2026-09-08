import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge for the Polkadot theme.
 *
 * Required, not optional. tailwind-merge resolves conflicts by sorting each
 * class into a group, and it only knows the groups Tailwind ships with. Every
 * name this theme adds is unrecognised, which fails in two directions:
 *
 *   MISCLASSIFIED - an unknown `text-*` falls through to the text-COLOUR group,
 *   so `cn('text-heading-l', 'text-fg-primary')` reads as two colours and drops
 *   one. atelier shipped this bug: white button labels rendered ink.
 *
 *   UNCLASSIFIED - `rounded-container` matches no group at all, so it never
 *   conflicts with `rounded-md` and both survive into the class string. Which
 *   one wins is then down to CSS source order, which is not something a caller
 *   can reason about.
 *
 * Registering the names below fixes both. Keep this list in step with the
 * @utility styles and @theme keys in theme/index.css - a style added there and
 * forgotten here is a silent drop, not a build error.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // The 14 named type styles. Each carries size + line-height + weight, so
      // they belong in font-size: two of them on one element is a conflict.
      'font-size': [
        {
          text: [
            'display-xl',
            'display-l',
            'heading-l',
            'heading-m',
            'heading-s',
            'label-l',
            'label-m',
            'label-s',
            'body-l',
            'body-m',
            'body-s',
            'caption',
            'code',
            'overline',
          ],
        },
      ],

      // --font-weight-regular has no stock equivalent (Tailwind calls it
      // `normal`), so font-regular would otherwise read as a font-FAMILY.
      'font-weight': [{ font: ['regular'] }],

      // Element-shaped radius names. Without these, rounded-container and
      // rounded-md coexist happily and neither wins predictably.
      rounded: [
        {
          rounded: ['container', 'nested', 'medium', 'small'],
        },
      ],

      // shadow-1/2/3 are numeric. tailwind-merge's stock `shadow` group only
      // accepts t-shirt sizes, so they fall through to shadow-COLOUR and stop
      // conflicting with one another. A literal entry here outranks that.
      shadow: [{ shadow: ['1', '2', '3'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
