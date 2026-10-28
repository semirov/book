/**
 * BOOK-128 #3863 (review) — the anchor rect is all that is left of the popover.
 *
 * The placement engine (`placePopover`), its viewport reader and its placement comparison are
 * deleted with the floating layer they served: the record is a block in the flow, a card is a
 * block after its row, and nothing is measured against a viewport any more. The rect type
 * stays because the page's stores still carry where a tap landed, and the report/debug paths
 * read it.
 */

export type AnchorRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};
