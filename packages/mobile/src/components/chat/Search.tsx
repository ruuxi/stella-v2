import { memo, useCallback, useMemo } from "react";
import {
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { GlassSurface } from "../glass";
import { Icon } from "../Icon";
import {
  buildSearchSnippet,
  foldQueryTerms,
  foldText,
} from "../../lib/chat-search-match";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import { type Colors } from "../../theme/colors";
import { fadeHex } from "../../theme/oklch";
import { fonts } from "../../theme/fonts";
import type { ChatMessage } from "../../types";

const SEARCH_DROPDOWN_GAP = 6;

type ChatSearchResult = { message: ChatMessage; index: number };
type SearchStyles = ReturnType<typeof makeSearchStyles>;

const searchResultKey = (result: ChatSearchResult) => result.message.id;

/**
 * Messages matching `query` (already trimmed), newest first. A message matches
 * when every folded term appears somewhere in it.
 */
export function useChatSearchResults(
  messages: ChatMessage[],
  open: boolean,
  query: string,
): ChatSearchResult[] {
  const active = query.length > 0;
  // Fold each message once (recomputed only when messages change) so each
  // keystroke just filters precomputed strings instead of re-normalizing the
  // whole history. Gated on the search being open: during streaming,
  // `messages` gets a new identity every frame, and folding the full
  // transcript per frame is pure waste while the results are unread.
  const foldedMessages = useMemo(() => {
    if (!open) {
      return [] as { message: ChatMessage; index: number; folded: string }[];
    }
    return messages.map((message, index) => ({
      message,
      index,
      folded: foldText(message.text),
    }));
  }, [open, messages]);
  return useMemo(() => {
    if (!active) return [] as ChatSearchResult[];
    const terms = foldQueryTerms(query);
    if (terms.length === 0) {
      return [] as ChatSearchResult[];
    }
    const out: ChatSearchResult[] = [];
    // Newest first; a message matches when every term appears somewhere in it.
    for (let i = foldedMessages.length - 1; i >= 0; i -= 1) {
      const entry = foldedMessages[i];
      if (terms.every((term) => entry.folded.includes(term))) {
        out.push({ message: entry.message, index: entry.index });
      }
    }
    return out;
  }, [foldedMessages, active, query]);
}

/**
 * The results menu that overlays the chat while searching (the chat itself is
 * never filtered). Tapping a result hands its transcript index to `onSelect`.
 */
export function ChatSearchResults({
  results,
  query,
  topInset,
  colors,
  onSelect,
}: {
  results: ChatSearchResult[];
  query: string;
  topInset: number;
  colors: Colors;
  onSelect: (index: number) => void;
}) {
  const styles = useMemo(() => makeSearchStyles(colors), [colors]);
  const { height: screenHeight } = useWindowDimensions();
  const renderSearchResult = useCallback(
    ({ item }: ListRenderItemInfo<ChatSearchResult>) => (
      <SearchResultRow
        message={item.message}
        index={item.index}
        query={query}
        styles={styles}
        colors={colors}
        onPress={onSelect}
      />
    ),
    [query, styles, colors, onSelect],
  );
  return (
    <View
      style={[
        styles.searchDropdown,
        {
          maxHeight: Math.max(160, screenHeight * 0.5),
          top: topInset + SEARCH_DROPDOWN_GAP,
        },
      ]}
    >
      <GlassSurface
        glass="regular"
        legible
        radius={14}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      {results.length === 0 ? (
        <Text style={styles.searchDropdownEmpty}>
          No messages match “{query}”
        </Text>
      ) : (
        <FlatList<ChatSearchResult>
          data={results}
          renderItem={renderSearchResult}
          keyExtractor={searchResultKey}
          extraData={query}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={3}
          style={styles.searchDropdownList}
          contentContainerStyle={styles.searchDropdownContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const SearchResultRow = memo(function SearchResultRow({
  message,
  index,
  query,
  styles,
  colors,
  onPress,
}: {
  message: ChatMessage;
  index: number;
  query: string;
  styles: SearchStyles;
  colors: Colors;
  onPress: (index: number) => void;
}) {
  const handlePress = useCallback(() => onPress(index), [index, onPress]);
  const snippet = useMemo(
    () => buildSearchSnippet(message.text, query),
    [message.text, query],
  );
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Jump to message: ${message.text.slice(0, 80)}`}
      style={({ pressed }) => [
        styles.searchResultRow,
        pressed && styles.searchResultRowPressed,
      ]}
    >
      <Text
        style={styles.searchResultText}
        numberOfLines={2}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
      >
        {snippet.before}
        <Text style={styles.searchResultMatch}>{snippet.match}</Text>
        {snippet.after}
      </Text>
      <Icon name="chevron-right" size={16} color={colors.textMuted} />
    </Pressable>
  );
});

const makeSearchStyles = (colors: Colors) =>
  StyleSheet.create({
    // Compact results popover that drops in just below the search field,
    // floating over the chat (which stays visible). Matches the `+` menu
    // surface so it reads as a menu, not a takeover.
    searchDropdown: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 4,
      left: 8,
      overflow: "hidden",
      position: "absolute",
      right: 8,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 12,
    },
    searchDropdownList: {
      flexGrow: 0,
    },
    searchDropdownContent: {
      paddingVertical: 4,
    },
    searchDropdownEmpty: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      paddingHorizontal: 16,
      paddingVertical: 18,
      textAlign: "center",
    },
    searchResultRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    searchResultRowPressed: {
      backgroundColor: fadeHex(colors.text, 0.06),
    },
    searchResultText: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 19,
    },
    searchResultMatch: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
    },
  } as const);
