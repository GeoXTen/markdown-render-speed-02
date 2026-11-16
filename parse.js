// parse.js — a fast Markdown-to-HTML renderer whose output is, for every
// input string, exactly the HTML that marked 18.1.3 produces with its
// default options (gfm: true, breaks: false, pedantic: false).
//
// This is a fork of marked (MIT License, see LICENSE and NOTICE in this
// repository) restructured for speed on a fixed option set:
//   * no extension, hook or option-merging machinery runs at parse time;
//   * every grammar regex is compiled once, when the module loads;
//   * the block and inline scanners dispatch on the current character and
//     only run the tokenizers that could possibly match there;
//   * nothing is cached between calls: parse(markdown) depends only on
//     the markdown it is given.
//
// The parsing rules themselves — including every place marked departs
// from the CommonMark or GFM spec — are marked's own, kept behaviourally
// identical so the HTML matches byte for byte.

// ---------------------------------------------------------------------
// Regex construction helpers (marked's edit() builder, kept small).
// ---------------------------------------------------------------------

const caretRe = /(^|[^\[])\^/g;

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(caretRe, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

const supportsLookbehind = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

// ---------------------------------------------------------------------
// Shared one-off regexes (marked's `other` table).
// ---------------------------------------------------------------------

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${tagNames})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// ---------------------------------------------------------------------
// Block grammar (the GFM variant of marked's rules; the default set).
// ---------------------------------------------------------------------

const tagNames = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const blockNewline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const blockFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const blockHr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const blockHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingGfm = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const blockDef = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const blockList = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bullet)
  .getRegex();

const commentRe = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const blockHtml = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', commentRe)
  .replace('tag', tagNames)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const paragraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function createParagraph(listInterrupt) {
  return edit(paragraphCore)
    .replace('hr', blockHr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', tagNames)
    .getRegex();
}

const blockquoteParagraph = createParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

const blockBlockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraph)
  .getRegex();

const gfmTable = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', blockHr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', tagNames)
  .getRegex();

const blockParagraphGfm = edit(paragraphCore)
  .replace('hr', blockHr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTable)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', tagNames)
  .getRegex();

const blockText = /^[^\n]+/;

const blockRules = {
  blockquote: blockBlockquote,
  code: blockCode,
  def: blockDef,
  fences: blockFences,
  heading: blockHeading,
  hr: blockHr,
  html: blockHtml,
  lheading: lheadingGfm,
  list: blockList,
  newline: blockNewline,
  paragraph: blockParagraphGfm,
  table: gfmTable,
  text: blockText,
};

// ---------------------------------------------------------------------
// Inline grammar (the GFM variant of marked's rules).
// ---------------------------------------------------------------------

const inlineEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const inlineBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const inlineTextNormal = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;

const punctuationRe = /[\p{P}\p{S}]/u;
const punctuationOrSpaceRe = /[\s\p{P}\p{S}]/u;
const notPunctuationOrSpaceRe = /[^\s\p{P}\p{S}]/u;
const punctuationGfmRe = /(?!~)[\p{P}\p{S}]/u;
const punctuationOrSpaceGfmRe = /(?!~)[\s\p{P}\p{S}]/u;
const notPunctuationOrSpaceGfmRe = /(?:[^\s\p{P}\p{S}]|~)/u;

const inlinePunctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, punctuationOrSpaceRe)
  .getRegex();

const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelimGfm = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, punctuationGfmRe)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';

const emStrongRDelimAstGfm = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, notPunctuationOrSpaceGfmRe)
  .replace(/punctSpace/g, punctuationOrSpaceGfmRe)
  .replace(/punct/g, punctuationGfmRe)
  .getRegex();

const emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, notPunctuationOrSpaceRe)
  .replace(/punctSpace/g, punctuationOrSpaceRe)
  .replace(/punct/g, punctuationRe)
  .getRegex();

const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, punctuationRe)
  .getRegex();

const delRDelimCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';

const delRDelim = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, notPunctuationOrSpaceRe)
  .replace(/punctSpace/g, punctuationOrSpaceRe)
  .replace(/punct/g, punctuationRe)
  .getRegex();

const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, punctuationRe)
  .getRegex();

const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, punctuationRe)
  .getRegex();

const inlineAutolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const inlineComment = edit(commentRe).replace('(?:-->|$)', '-->').getRegex();
const inlineTag = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', inlineLabelBrackets)
  .getRegex();

const inlineLink = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const inlineReflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', inlineLabel)
  .replace('ref', blockLabel)
  .getRegex();

const inlineNolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', blockLabel)
  .getRegex();

const boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', inlineLabelBrackets)
  .getRegex();

const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', boundedInlineLabel)
    .replace('ref', boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', boundedBlockLabel)
    .getRegex())
  .getRegex();

const caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, extendedEmail)
  .getRegex();

const inlineUrl = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', extendedEmailProtocol)
  .replace('protocol', caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();

const inlineBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const inlineTextGfm = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

const inlineRules = {
  _backpedal: inlineBackpedal,
  anyPunctuation,
  anyPunctuationOutsideCode,
  autolink: inlineAutolink,
  blockSkip,
  br: inlineBr,
  code: inlineCode,
  delLDelim,
  delRDelim,
  emStrongLDelim: emStrongLDelimGfm,
  emStrongRDelimAst: emStrongRDelimAstGfm,
  emStrongRDelimUnd,
  escape: inlineEscape,
  link: inlineLink,
  nolink: inlineNolink,
  punctuation: inlinePunctuation,
  reflink: inlineReflink,
  reflinkSearch,
  tag: inlineTag,
  text: inlineTextGfm,
  url: inlineUrl,
};

const rules = { other, block: blockRules, inline: inlineRules };

// ---------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch) => escapeReplacements[ch];

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (other.escapeTest.test(html)) {
      return html.replace(other.escapeReplace, getEscapeReplacement);
    }
  } else if (other.escapeTestNoEncode.test(html)) {
    return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (!other.numericCharacterReference.test(text)) {
    return text;
  }
  return text.replace(other.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '�';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    if (escaped) {
      return '|';
    }
    return ' |';
  });
  const cells = row.split(other.splitPipe);
  let i = 0;

  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }

  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }

  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) {
    end--;
  }
  if (lines.length - end <= 2) {
    return str;
  }
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }
  return -1;
}

function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// Index of the first character that is not a plain space (what a
// search for /[^ ]/ returns), or -1 when there is none.
function firstNonSpaceIndex(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') return i;
  }
  return -1;
}

// The same index computed on the string with every tab widened to
// four spaces (what searching the tab-replaced string returns).
function expandedFirstNonSpaceIndex(s) {
  let idx = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') idx += 4;
    else if (ch === ' ') idx += 1;
    else return idx;
  }
  return -1;
}

// Expand tabs in a line's leading whitespace run (the only part the
// list tokenizer rewrites). A run without a tab expands to itself, so
// the replace only runs when a tab is actually there.
function expandLeadingTabs(s, indent) {
  if (s[0] !== ' ' && s[0] !== '\t') return s;
  let i = 0;
  let hasTab = false;
  while (s[i] === ' ' || s[i] === '\t') {
    if (s[i] === '\t') hasTab = true;
    i++;
  }
  if (!hasTab) return s;
  return s.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, indent));
}

// Note: the GFM inline-text token is found with marked's own regex.
// A hand-written scanner for its stop conditions was tried and
// measured slower than the regex engine, so the regex stays.

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// One scan of a masked inline source finds the last run of *, _ or ~
// that could close an emphasis/strong/del span (a run not preceded by
// ASCII whitespace). The lexer keeps a small stack of these frames for
// the inline passes currently running; emStrong and del consult the top
// frame and bail early when no closer can exist in their window.
// Cheap necessary conditions for the two most expensive block regexes.
// The setext (lheading) regex lazily scans a whole paragraph hunting for
// its underline line; a match needs a line shaped like an underline (up
// to three spaces, a run of = or -, then only spaces/tabs to the line's
// end) on some line before the first blank line, because the heading
// text cannot cross a blank line. lheadingPossible walks just those
// lines. The GFM table regex likewise cannot match unless the second
// line is shaped like a delimiter row (only spaces, pipes, colons and
// dashes, with a dash and a pipe or colon among them).
function lheadingPossible(src) {
  let pos = 0;
  for (;;) {
    const nl = src.indexOf('\n', pos);
    if (nl === -1) return false;
    // Examine the line that starts right after this newline.
    let j = nl + 1;
    let spaces = 0;
    while (src[j] === ' ' && spaces < 4) { j++; spaces++; }
    if (spaces <= 3 && (src[j] === '=' || src[j] === '-')) {
      const ch = src[j];
      let k = j;
      while (src[k] === ch) k++;
      let m = k;
      while (src[m] === ' ' || src[m] === '\t') m++;
      if (src[m] === '\n' || src[m] === undefined) return true;
    }
    // A blank line ends the search: the heading text cannot cross it.
    let b = nl + 1;
    while (src[b] === ' ' || src[b] === '\t') b++;
    if (src[b] === '\n' || src[b] === undefined) return false;
    pos = nl + 1;
  }
}

const tableDelimLine = /^ {0,3}[| :\-]*$/;

function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  const start = nl + 1;
  let end = src.indexOf('\n', start);
  if (end === -1) end = src.length;
  const line = src.slice(start, end);
  return line.includes('-')
    && (line.includes('|') || line.includes(':'))
    && tableDelimLine.test(line);
}

function scanLastPossibleClosers(src) {
  const lastEmStrong = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        lastDel = i;
      } else {
        lastEmStrong[ch] = i;
      }
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEmStrong, lastDel };
}

// ---------------------------------------------------------------------
// Tokenizer: one method per token kind, in marked's shapes.
// ---------------------------------------------------------------------

function outputLink(cap, link, raw, lexer) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = lexer.state.inLink;
  const outerLinkEmitted = lexer.state.linkEmitted;
  const outerInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const textHasLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = outerLinkEmitted;
  lexer.state.inLink = outerInLink;

  if (!isImage) {
    // Links may not contain other links; bail so the inner link wins.
    if (textHasLink) {
      lexer.state.inRawBlock = outerInRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }

  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title,
    text,
    tokens,
  };
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) {
    return text;
  }
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(other.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }
      const [indentInNode] = matchIndentInNode;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = rules.inline.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') {
      continue;
    }
    const tokenSrc = src.slice(labelStart + i);
    const token = rules.inline.tag.exec(tokenSrc) || rules.inline.autolink.exec(tokenSrc);
    if (!token) {
      continue;
    }
    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

class Tokenizer {
  constructor() {
    this.rules = rules;
    this.lexer = null;
  }

  space(src) {
    const cap = this.rules.block.newline.exec(src);
    if (cap && cap[0].length > 0) {
      return { type: 'space', raw: cap[0] };
    }
    return undefined;
  }

  code(src) {
    const cap = this.rules.block.code.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const text = raw.replace(this.rules.other.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
    return undefined;
  }

  fences(src) {
    const cap = this.rules.block.fences.exec(src);
    if (cap) {
      const raw = cap[0];
      const text = indentCodeCompensation(raw, cap[3] || '');
      return {
        type: 'code',
        raw,
        lang: cap[2] ? cap[2].trim().replace(this.rules.inline.anyPunctuation, '$1') : cap[2],
        text,
      };
    }
    return undefined;
  }

  heading(src) {
    const cap = this.rules.block.heading.exec(src);
    if (cap) {
      let text = cap[2].trim();
      if (this.rules.other.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || this.rules.other.endingSpaceTabChar.test(trimmed)) {
          text = trimmed.trim();
        }
      }
      return {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
    return undefined;
  }

  hr(src) {
    const cap = this.rules.block.hr.exec(src);
    if (cap) {
      return { type: 'hr', raw: rtrim(cap[0], '\n') };
    }
    return undefined;
  }

  blockquote(src) {
    const cap = this.rules.block.blockquote.exec(src);
    if (cap) {
      let lines = rtrim(cap[0], '\n').split('\n');
      let raw = '';
      let text = '';
      const tokens = [];

      while (lines.length > 0) {
        let inBlockquote = false;
        const currentLines = [];

        let i;
        for (i = 0; i < lines.length; i++) {
          if (this.rules.other.blockquoteStart.test(lines[i])) {
            currentLines.push(lines[i]);
            inBlockquote = true;
          } else if (!inBlockquote) {
            currentLines.push(lines[i]);
          } else {
            break;
          }
        }
        lines = lines.slice(i);

        const currentRaw = currentLines.join('\n');
        const currentText = currentRaw
          .replace(
            this.rules.other.blockquoteMarkerWhitespace,
            (_m, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
          )
          .replace(this.rules.other.blockquoteSetextReplace, '\n    $1')
          .replace(this.rules.other.blockquoteSetextReplace2, '');
        raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
        text = text ? `${text}\n${currentText}` : currentText;

        const top = this.lexer.state.top;
        this.lexer.state.top = true;
        this.lexer.blockTokens(currentText, tokens, true);
        this.lexer.state.top = top;

        if (lines.length === 0) {
          break;
        }

        const lastToken = tokens.at(-1);

        if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
          break;
        } else if (lastToken?.type === 'blockquote') {
          const oldToken = lastToken;
          const continuation = lines.join('\n');
          const newText = oldToken.raw + '\n' + continuation.replace(this.rules.other.blockquoteSetextReplace2, '');
          const newToken = this.blockquote(newText);
          tokens[tokens.length - 1] = newToken;

          const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
          const leftoverCount = leftover ? leftover.split('\n').length : 0;
          const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
          if (consumed.length > 0) {
            raw = `${raw}\n${consumed.join('\n')}`;
          }
          text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

          lines = lines.slice(consumed.length);
          if (lines.length > 0 && this.rules.other.blockquoteStart.test(lines[0])) {
            continue;
          }
          break;
        } else if (lastToken?.type === 'list') {
          const oldToken = lastToken;
          const newText = oldToken.raw + '\n' + lines.join('\n');
          const newToken = this.list(newText);
          tokens[tokens.length - 1] = newToken;

          const consumedCount = newToken.raw.length > oldToken.raw.length
            ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
            : 0;
          if (consumedCount > 0) {
            const consumed = lines.slice(0, consumedCount).join('\n');
            raw = `${raw}\n${consumed}`;
            text = `${text}\n${consumed}`;
          }
          lines = lines.slice(consumedCount);
          continue;
        }
      }

      return { type: 'blockquote', raw, tokens, text };
    }
    return undefined;
  }

  list(src) {
    let cap = this.rules.block.list.exec(src);
    if (cap) {
      const listSrc = src;
      const taken = () => listSrc.length - src.length;
      let bull = cap[1].trim();
      const isordered = bull.length > 1;

      const list = {
        type: 'list',
        raw: '',
        ordered: isordered,
        start: isordered ? +bull.slice(0, -1) : '',
        loose: false,
        items: [],
      };

      bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

      const itemRegex = this.rules.other.listItemRegex(bull);
      let endsWithBlankLine = false;
      while (src) {
        let endEarly = false;
        let itemContents = '';
        if (!(cap = itemRegex.exec(src))) {
          break;
        }

        if (this.rules.block.hr.test(src)) {
          break;
        }

        const itemStart = taken();
        src = src.substring(cap[0].length);

        let firstLine = cap[2];
        if (firstLine.endsWith('\n')) firstLine = firstLine.slice(0, -1);
        const bulletIndent = cap[1].length;
        let line = expandLeadingTabs(firstLine, bulletIndent);
        let nextLine = firstLineOf(src);
        let blankLine = !line.trim();

        let indent = 0;
        if (blankLine) {
          indent = bulletIndent + 1;
        } else {
          indent = firstNonSpaceIndex(line);
          indent = indent > 4 ? 1 : indent;
          itemContents = line.slice(indent);
          indent += bulletIndent;
        }

        if (blankLine && this.rules.other.blankLine.test(nextLine)) {
          src = src.substring(nextLine.length + 1);
          endEarly = true;
        }

        if (!endEarly) {
          const nextBulletRegex = this.rules.other.nextBulletRegex(indent);
          const hrRegex = this.rules.other.hrRegex(indent);
          const fencesBeginRegex = this.rules.other.fencesBeginRegex(indent);
          const headingBeginRegex = this.rules.other.headingBeginRegex(indent);
          const htmlBeginRegex = this.rules.other.htmlBeginRegex(indent);
          const blockquoteBeginRegex = this.rules.other.blockquoteBeginRegex(indent);

          // The six "begin" regexes all share the shape ^ {0,N} plus
          // one opening character, with the same N for a given indent.
          // A line whose first non-space character is none of those
          // characters (or that is indented past N) fails all six, so
          // the tests only run for the characters that can pass.
          const beginIndent = Math.max(0, Math.min(3, indent - 1));

          while (src) {
            const rawLine = firstLineOf(src);
            let nextLineWithoutTabs;
            nextLine = rawLine;

            nextLineWithoutTabs = expandLeadingTabs(nextLine);

            let nls = 0;
            while (nextLine[nls] === ' ') nls++;
            const nfc = nextLine[nls];
            if (nls <= beginIndent) {
              if ((nfc === '`' || nfc === '~') && fencesBeginRegex.test(nextLine)) {
                break;
              }
              if (nfc === '#' && headingBeginRegex.test(nextLine)) {
                break;
              }
              if (nfc === '<' && htmlBeginRegex.test(nextLine)) {
                break;
              }
              if (nfc === '>' && blockquoteBeginRegex.test(nextLine)) {
                break;
              }
              if ((nfc === '*' || nfc === '+' || nfc === '-' || (nfc >= '0' && nfc <= '9')) && nextBulletRegex.test(nextLine)) {
                break;
              }
              if ((nfc === '-' || nfc === '_' || nfc === '*') && hrRegex.test(nextLine)) {
                break;
              }
            }

            if (firstNonSpaceIndex(nextLineWithoutTabs) >= indent || !nextLine.trim()) {
              itemContents += '\n' + nextLineWithoutTabs.slice(indent);
            } else {
              if (blankLine) {
                break;
              }
              if (expandedFirstNonSpaceIndex(line) >= 4) {
                break;
              }
              let lls = 0;
              while (line[lls] === ' ') lls++;
              const lfc = line[lls];
              if (lls <= beginIndent) {
                if ((lfc === '`' || lfc === '~') && fencesBeginRegex.test(line)) {
                  break;
                }
                if (lfc === '#' && headingBeginRegex.test(line)) {
                  break;
                }
                if (lfc === '<' && htmlBeginRegex.test(line)) {
                  break;
                }
                if ((lfc === '-' || lfc === '_' || lfc === '*') && hrRegex.test(line)) {
                  break;
                }
              }

              const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
                && this.rules.block.lheading.test(`${line}\n${nextLine}`);
              const continuation = setextContinuation
                ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
                : nextLine;
              itemContents += '\n' + continuation;
            }

            blankLine = !nextLine.trim();

            src = src.substring(rawLine.length + 1);
            line = nextLineWithoutTabs.slice(indent);
          }
        }

        const raw = listSrc.slice(itemStart, taken());

        if (!list.loose) {
          if (endsWithBlankLine) {
            list.loose = true;
          } else if (this.rules.other.doubleBlankLine.test(raw)) {
            endsWithBlankLine = true;
          }
        }

        list.items.push({
          type: 'list_item',
          raw,
          task: !!this.rules.other.listIsTask.test(itemContents),
          loose: false,
          text: itemContents,
          tokens: [],
        });
      }

      const lastItem = list.items.at(-1);
      if (lastItem) {
        lastItem.raw = lastItem.raw.trimEnd();
        lastItem.text = lastItem.text.trimEnd();
      } else {
        return undefined;
      }
      list.raw = listSrc.slice(0, taken()).trimEnd();

      for (const item of list.items) {
        this.lexer.state.top = false;
        item.tokens = this.lexer.blockTokens(item.text, []);

        if (!list.loose) {
          const spacers = item.tokens.filter((t) => t.type === 'space');
          const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => this.rules.other.anyLine.test(t.raw));
          list.loose = hasMultipleLineBreaks;
        }
      }

      for (const item of list.items) {
        const itemToken = item.tokens[0];
        if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
          item.text = item.text.replace(this.rules.other.listReplaceTask, '');
          itemToken.raw = itemToken.raw.replace(this.rules.other.listReplaceTask, '');
          itemToken.text = itemToken.text.replace(this.rules.other.listReplaceTask, '');
          for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
            if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[i].src)) {
              this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(this.rules.other.listReplaceTask, '');
              break;
            }
          }

          const taskRaw = this.rules.other.listTaskCheckbox.exec(item.raw);
          if (taskRaw) {
            const checkboxToken = {
              type: 'checkbox',
              raw: taskRaw[0] + ' ',
              checked: taskRaw[0] !== '[ ]',
            };
            item.checked = checkboxToken.checked;
            if (list.loose) {
              if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
                item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
                item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
                item.tokens[0].tokens.unshift(checkboxToken);
              } else {
                item.tokens.unshift({
                  type: 'paragraph',
                  raw: checkboxToken.raw,
                  text: checkboxToken.raw,
                  tokens: [checkboxToken],
                });
              }
            } else {
              item.tokens.unshift(checkboxToken);
            }
          }
        } else if (item.task) {
          item.task = false;
        }
      }

      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const token of item.tokens) {
            if (token.type === 'text') {
              token.type = 'paragraph';
            }
          }
        }
      }

      return list;
    }
    return undefined;
  }

  html(src) {
    const cap = this.rules.block.html.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      return {
        type: 'html',
        block: true,
        raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
    }
    return undefined;
  }

  def(src) {
    const cap = this.rules.block.def.exec(src);
    if (cap) {
      if (!this.rules.other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
        return undefined;
      }
      const tag = normalizeLabel(cap[1]);
      const href = cap[2] ? cap[2].replace(this.rules.other.hrefBrackets, '$1').replace(this.rules.inline.anyPunctuation, '$1') : '';
      const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(this.rules.inline.anyPunctuation, '$1') : cap[3];
      return {
        type: 'def',
        tag,
        raw: rtrim(cap[0], '\n'),
        href,
        title,
      };
    }
    return undefined;
  }

  table(src) {
    if (!tablePossible(src)) {
      return undefined;
    }
    const cap = this.rules.block.table.exec(src);
    if (!cap) {
      return undefined;
    }
    if (!this.rules.other.tableDelimiter.test(cap[2])) {
      return undefined;
    }

    const headers = splitCells(cap[1]);
    const aligns = cap[2].replace(this.rules.other.tableAlignChars, '').split('|');
    const rows = cap[3]?.trim() ? cap[3].replace(this.rules.other.tableRowBlankLine, '').split('\n') : [];

    const item = {
      type: 'table',
      raw: rtrim(cap[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };

    if (headers.length !== aligns.length) {
      return undefined;
    }

    for (const align of aligns) {
      if (this.rules.other.tableAlignRight.test(align)) {
        item.align.push('right');
      } else if (this.rules.other.tableAlignCenter.test(align)) {
        item.align.push('center');
      } else if (this.rules.other.tableAlignLeft.test(align)) {
        item.align.push('left');
      } else {
        item.align.push(null);
      }
    }

    for (let i = 0; i < headers.length; i++) {
      item.header.push({
        text: headers[i],
        tokens: this.lexer.inline(headers[i]),
        header: true,
        align: item.align[i],
      });
    }

    for (const row of rows) {
      item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
        text: cell,
        tokens: this.lexer.inline(cell),
        header: false,
        align: item.align[i],
      })));
    }

    return item;
  }

  lheading(src) {
    if (!lheadingPossible(src)) {
      return undefined;
    }
    const cap = this.rules.block.lheading.exec(src);
    if (cap) {
      const text = cap[1].trim();
      return {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
    return undefined;
  }

  paragraph(src) {
    const cap = this.rules.block.paragraph.exec(src);
    if (cap) {
      const text = cap[1].charAt(cap[1].length - 1) === '\n'
        ? cap[1].slice(0, -1)
        : cap[1];
      return {
        type: 'paragraph',
        raw: cap[0],
        text,
        tokens: this.lexer.inline(text),
      };
    }
    return undefined;
  }

  text(src) {
    const cap = this.rules.block.text.exec(src);
    if (cap) {
      return {
        type: 'text',
        raw: cap[0],
        text: cap[0],
        tokens: this.lexer.inline(cap[0]),
      };
    }
    return undefined;
  }

  escape(src) {
    const cap = this.rules.inline.escape.exec(src);
    if (cap) {
      return { type: 'escape', raw: cap[0], text: cap[1] };
    }
    return undefined;
  }

  tag(src) {
    const cap = this.rules.inline.tag.exec(src);
    if (cap) {
      if (!this.lexer.state.inLink && this.rules.other.startATag.test(cap[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && this.rules.other.endATag.test(cap[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = false;
      }
      return {
        type: 'html',
        raw: cap[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false,
        text: cap[0],
      };
    }
    return undefined;
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) {
      return undefined;
    }
    const cap = this.rules.inline.link.exec(src);
    if (cap) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, cap[1], labelStart)) {
        return undefined;
      }

      const trimmedUrl = cap[2].trim();
      if (this.rules.other.startAngleBracket.test(trimmedUrl)) {
        if (!(this.rules.other.endAngleBracket.test(trimmedUrl))) {
          return undefined;
        }
        const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
        if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
          return undefined;
        }
      } else {
        const lastParenIndex = findClosingBracket(cap[2], '()');
        if (lastParenIndex === -2) {
          return undefined;
        }
        if (lastParenIndex > -1) {
          const start = cap[0].indexOf('!') === 0 ? 5 : 4;
          const linkLen = start + cap[1].length + lastParenIndex;
          cap[2] = cap[2].substring(0, lastParenIndex);
          cap[0] = cap[0].substring(0, linkLen).trim();
          cap[3] = '';
        }
      }
      const unescaped = rtrim(cap[0].slice(0, -1), '\\');
      if ((cap[0].length - unescaped.length) % 2 === 0) {
        return undefined;
      }
      let href = cap[2];
      let title = cap[3] ? cap[3].slice(1, -1) : '';

      href = href.trim();
      if (this.rules.other.startAngleBracket.test(href)) {
        href = href.slice(1, -1);
      }
      return outputLink(cap, {
        href: href ? href.replace(this.rules.inline.anyPunctuation, '$1') : href,
        title: title ? title.replace(this.rules.inline.anyPunctuation, '$1') : title,
      }, cap[0], this.lexer);
    }
    return undefined;
  }

  reflink(src, links) {
    let cap;
    if ((cap = this.rules.inline.reflink.exec(src))
      || (cap = this.rules.inline.nolink.exec(src))) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, cap[1], labelStart)) {
        return undefined;
      }
      const link = links[normalizeLabel(cap[2] || cap[1])];
      if (!link) {
        const text = cap[0].charAt(0);
        return { type: 'text', raw: text, text };
      }
      return outputLink(cap, link, cap[0], this.lexer);
    }
    return undefined;
  }

  emStrong(src, maskedSrc, prevChar = '') {
    let match = this.rules.inline.emStrongLDelim.exec(src);
    if (!match) return undefined;
    if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;

    const delimChar = match[0][0];
    const midRun = prevChar === delimChar;

    const srcStart = maskedSrc.length - src.length;
    let runStart = srcStart;
    while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
      runStart--;
    }
    const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!this.rules.inline.punctuation.exec(runPrevChar);
    if (runStart < srcStart) {
      prevChar = runPrevChar;
    }
    const prevPunct = runStart < srcStart ? runPrevPunct : !!this.rules.inline.punctuation.exec(prevChar);

    if (match[4] && prevChar.match(this.rules.other.unicodeAlphaNumeric)) return undefined;

    const nextChar = match[1] || match[3] || '';

    if (!nextChar || !prevChar || prevPunct) {
      const lLength = [...match[0]].length - 1;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !!runPrevChar.trim()
        && (!!nextChar || (delimChar === '*' && !runPrevPunct));
      if (delimChar !== '*' && delimChar !== '_') return undefined;
      const endReg = delimChar === '*' ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      const frame = this.lexer.closerStack.at(-1);
      const lastPossibleCloserIndex = frame && frame.maskedSrc === maskedSrc
        ? frame.lastEmStrong[delimChar]
        : scanLastPossibleClosers(maskedSrc).lastEmStrong[delimChar];
      const closerWindowStart = maskedSrc.length - src.length + lLength;
      if (lastPossibleCloserIndex < closerWindowStart) return undefined;
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      const lastPossibleCloserIndexInWindow = lastPossibleCloserIndex - closerWindowStart;
      endReg.lastIndex = 0;

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastPossibleCloserIndexInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue;

        // rDelim is a run of * or _ only, so its code-point count is
        // its length.
        rLength = rDelim.length;

        if (match[3] || match[4]) {
          delimTotal += rLength;
          continue;
        } else if (match[5] || match[6] || openerCanClose) {
          if (midRun && (match[5] || match[6])) {
            break;
          }
          if (runLength % 3 && !((runLength + rLength) % 3)) {
            midDelimTotal += rLength;
            continue;
          }
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue;

        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        // Length in code units of the match's first code point.
        const firstCode = match[0].charCodeAt(0);
        const lastCharLength = firstCode >= 0xd800 && firstCode <= 0xdbff ? 2 : 1;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

        if (Math.min(lLength, rLength) % 2) {
          const text = raw.slice(1, -1);
          return {
            type: 'em',
            raw,
            text,
            tokens: this.lexer.inlineTokens(text),
          };
        }

        const text = raw.slice(2, -2);
        return {
          type: 'strong',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
    return undefined;
  }

  codespan(src) {
    const cap = this.rules.inline.code.exec(src);
    if (cap) {
      let text = cap[2].replace(this.rules.other.newLineCharGlobal, ' ');
      const hasNonSpaceChars = this.rules.other.nonSpaceChar.test(text);
      const hasSpaceCharsOnBothEnds = this.rules.other.startingSpaceChar.test(text) && this.rules.other.endingSpaceChar.test(text);
      if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
        text = text.substring(1, text.length - 1);
      }
      return { type: 'codespan', raw: cap[0], text };
    }
    return undefined;
  }

  br(src) {
    const cap = this.rules.inline.br.exec(src);
    if (cap) {
      return { type: 'br', raw: cap[0] };
    }
    return undefined;
  }

  del(src, maskedSrc, prevChar = '') {
    let match = this.rules.inline.delLDelim.exec(src);
    if (!match) return undefined;

    const nextChar = match[1] || '';

    if (!nextChar || !prevChar || this.rules.inline.punctuation.exec(prevChar)) {
      const lLength = [...match[0]].length - 1;
      let rDelim, rLength, delimTotal = lLength;

      const endReg = this.rules.inline.delRDelim;
      const frame = this.lexer.closerStack.at(-1);
      const lastPossibleDelIndex = frame && frame.maskedSrc === maskedSrc
        ? frame.lastDel
        : scanLastPossibleClosers(maskedSrc).lastDel;
      const closerWindowStart = maskedSrc.length - src.length + lLength;
      if (lastPossibleDelIndex < closerWindowStart) return undefined;
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      const lastPossibleDelIndexInWindow = lastPossibleDelIndex - closerWindowStart;
      endReg.lastIndex = 0;

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastPossibleDelIndexInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue;

        // rDelim is a run of ~ only, so its code-point count is its
        // length.
        rLength = rDelim.length;

        if (rLength !== lLength) continue;

        if (match[3] || match[4]) {
          delimTotal += rLength;
          continue;
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue;

        rLength = Math.min(rLength, rLength + delimTotal);
        const firstCode = match[0].charCodeAt(0);
        const lastCharLength = firstCode >= 0xd800 && firstCode <= 0xdbff ? 2 : 1;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

        const text = raw.slice(lLength, -lLength);
        return {
          type: 'del',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
    return undefined;
  }

  autolink(src) {
    const cap = this.rules.inline.autolink.exec(src);
    if (cap) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[1];
        href = 'mailto:' + text;
      } else {
        text = cap[1];
        href = text;
      }
      return {
        type: 'link',
        raw: cap[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
    return undefined;
  }

  url(src) {
    let cap;
    if (cap = this.rules.inline.url.exec(src)) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[0];
        href = 'mailto:' + text;
      } else {
        let prevCapZero;
        do {
          prevCapZero = cap[0];
          cap[0] = this.rules.inline._backpedal.exec(cap[0])?.[0] ?? '';
        } while (prevCapZero !== cap[0]);
        text = cap[0];
        if (cap[1] === 'www.') {
          href = 'http://' + cap[0];
        } else {
          href = cap[0];
        }
      }
      return {
        type: 'link',
        raw: cap[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
    return undefined;
  }

  inlineText(src) {
    const cap = this.rules.inline.text.exec(src);
    if (cap) {
      const escaped = this.lexer.state.inRawBlock;
      return {
        type: 'text',
        raw: cap[0],
        text: escaped ? cap[0] : decodeNumericCharacterReferences(cap[0]),
        escaped,
      };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------
// Lexer: block pass first (collecting link definitions), then the
// queued inline sources are tokenized.
// ---------------------------------------------------------------------

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.linkCount = 0;
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.closerStack = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
  }

  lex(src) {
    src = src.replace(other.carriageReturn, '\n');

    this.blockTokens(src, this.tokens);

    for (let i = 0; i < this.inlineQueue.length; i++) {
      const next = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(next.src, next.tokens);
    }
    this.inlineQueue = [];

    return this.tokens;
  }

  blockTokens(src, tokens = [], lastParagraphClipped = false) {
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }

      let token;

      // Dispatch facts for this position: how many plain spaces lead the
      // line, the first character past them, and whether the position is
      // a blank line. Every block regex in marked's grammar opens with
      // ` {0,3}` plus one specific character (or, for indented code, four
      // spaces / a tab), so a tokenizer whose opening character cannot
      // occur here can be skipped without changing which token wins:
      // the survivors are still tried in marked's own order.
      let sp = 0;
      while (sp < 4 && src[sp] === ' ') sp++;
      const first = src[sp];
      let blank = sp > 0 || first === '\t' || first === '\n' || first === undefined;
      if (blank && first !== '\n' && first !== undefined) {
        let j = sp;
        while (src[j] === ' ' || src[j] === '\t') j++;
        blank = src[j] === '\n' || src[j] === undefined;
      }

      // newline
      if (blank && (token = this.tokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }

      // indented code: four spaces, or up to three spaces and a tab,
      // followed by a non-newline character
      const codePossible = src.startsWith('    ')
        ? src[4] !== undefined && src[4] !== '\n'
        : first === '\t' && src[sp + 1] !== undefined && src[sp + 1] !== '\n';
      if (codePossible && (token = this.tokenizer.code(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // fences
      if (sp < 4 && (first === '`' || first === '~') && (token = this.tokenizer.fences(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // heading
      if (sp < 4 && first === '#' && (token = this.tokenizer.heading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // hr
      if (sp < 4 && (first === '-' || first === '_' || first === '*') && (token = this.tokenizer.hr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // blockquote
      if (sp < 4 && first === '>' && (token = this.tokenizer.blockquote(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // list
      if (sp < 4 && (first === '*' || first === '+' || first === '-' || (first >= '0' && first <= '9')) && (token = this.tokenizer.list(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // html
      if (sp < 4 && first === '<' && (token = this.tokenizer.html(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // def
      if (sp < 4 && first === '[' && (token = this.tokenizer.def(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = {
              href: token.href,
              title: token.title,
            };
            this.linkCount++;
          }
          tokens.push(token);
        }
        continue;
      }

      // table (gfm)
      if (token = this.tokenizer.table(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // lheading
      if (token = this.tokenizer.lheading(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // top-level paragraph
      if (this.state.top && (token = this.tokenizer.paragraph(src))) {
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = false;
        src = src.substring(token.raw.length);
        continue;
      }

      // text
      if (token = this.tokenizer.text(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }

    this.state.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  linkInText(text) {
    if (!text.includes('[')) {
      return false;
    }

    const linkRule = rules.inline.link;
    for (const match of text.matchAll(rules.inline.blockSkip)) {
      if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
        return true;
      }
    }

    for (const match of text.matchAll(rules.inline.reflinkSearch)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        continue;
      }
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) {
        continue;
      }
      return true;
    }

    return false;
  }

  inlineTokens(src, tokens = []) {
    const prevLinkParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
    try {
      return this.inlineTokensInner(src, tokens);
    } finally {
      this.state.linkParenPossible = prevLinkParenPossible;
    }
  }

  inlineTokensInner(src, tokens) {
    const maskedSrc = src.includes('*') || src.includes('_') || src.includes('~')
      ? this.maskSrc(src)
      : src;

    this.closerStack.push(scanLastPossibleClosers(maskedSrc));
    try {
      return this.tokenizeInlines(src, maskedSrc, tokens);
    } finally {
      this.closerStack.pop();
    }
  }

  tokenizeInlines(src, maskedSrc, tokens) {
    let keepPrevChar = false;
    let prevChar = '';
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }

      if (!keepPrevChar) {
        prevChar = '';
      }
      keepPrevChar = false;

      let token;

      // Inline dispatch: every inline grammar in marked's set opens
      // with one specific character, so only the tokenizers that could
      // match at this character are run, still in marked's order. The
      // text tokenizer is the universal fallback and runs last, as
      // before. (url is the one exception: its alternatives open with
      // a letter, a digit or one of . _ + -, the characters an email
      // address, a protocol or a www. prefix can start with.)
      const c = src[0];
      const bracket = c === '[' || (c === '!' && src[1] === '[');

      // escape
      if (c === '\\' && (token = this.tokenizer.escape(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // tag
      if (c === '<' && (token = this.tokenizer.tag(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // link
      if (bracket && (token = this.tokenizer.link(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // reflink, nolink
      if (bracket && (token = this.tokenizer.reflink(src, this.tokens.links))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.type === 'text' && lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // em & strong
      if ((c === '*' || c === '_') && (token = this.tokenizer.emStrong(src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // code
      if (c === '`' && (token = this.tokenizer.codespan(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // br
      if ((c === ' ' || c === '\\') && (token = this.tokenizer.br(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // del (gfm)
      if (c === '~' && (token = this.tokenizer.del(src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // autolink
      if (c === '<' && (token = this.tokenizer.autolink(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // url (gfm)
      if (!this.state.inLink
        && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
          || c === '.' || c === '_' || c === '+' || c === '-')
        && (token = this.tokenizer.url(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      // text
      if (token = this.tokenizer.inlineText(src)) {
        src = src.substring(token.raw.length);
        if (token.raw.slice(-1) !== '_') {
          prevChar = token.raw.slice(-1);
        }
        keepPrevChar = true;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }

    return tokens;
  }

  maskSrc(src) {
    let maskedSrc = src;

    // Mask out reflinks (impossible when no definition was collected:
    // every candidate would be handed back unchanged by the callback)
    if (this.linkCount > 0 && src.includes('[')) {
      const reflinkSearch = rules.inline.reflinkSearch;
      const maskReflink = (match0) => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
          return match0;
        }
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(reflinkSearch, maskReflink)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
    }

    // Mask out escaped characters (keeping code spans intact). The
    // pattern can only change something when a backslash or a backtick
    // is present at all.
    if (maskedSrc.includes('\\') || maskedSrc.includes('`')) {
      maskedSrc = maskedSrc.replace(rules.inline.anyPunctuationOutsideCode, (match0, code, punct) => {
        if (punct) {
          return '+'.repeat(match0.length);
        }
        if (code) {
          return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        }
        return match0;
      });
    }

    // Mask out other blocks (links, code spans, html). Each alternative
    // needs its opening character: [ for a link, ` for a code span,
    // < for a tag.
    if (maskedSrc.includes('[') || maskedSrc.includes('`') || maskedSrc.includes('<')) {
      maskedSrc = maskedSrc.replace(rules.inline.blockSkip, (match0, _link, context) => {
        const offset = context ? context.length : 0;
        return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
      });
    }

    return maskedSrc;
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}

// ---------------------------------------------------------------------
// Rendering: tokens to HTML, marked's default renderer shapes.
// ---------------------------------------------------------------------

const textRenderer = {
  strong(token, parser) {
    return token.tokens ? parser.parseInline(token.tokens, textRenderer) : token.text;
  },
  em(token, parser) {
    return token.tokens ? parser.parseInline(token.tokens, textRenderer) : token.text;
  },
  codespan(token) {
    return token.text;
  },
  del(token, parser) {
    return token.tokens ? parser.parseInline(token.tokens, textRenderer) : token.text;
  },
  html(token) {
    return token.text;
  },
  text(token) {
    return token.text;
  },
  link(token, parser) {
    return token.tokens ? parser.parseInline(token.tokens, textRenderer) : token.text;
  },
  image(token, parser) {
    return token.tokens ? parser.parseInline(token.tokens, textRenderer) : token.text;
  },
  br() {
    return '';
  },
  checkbox(token) {
    return token.raw;
  },
};

const renderer = {
  space() {
    return '';
  },

  code({ text, lang, escaped }) {
    const langString = (lang || '').match(other.notSpaceStart)?.[0];
    const code = text ? text.replace(other.endingNewline, '') + '\n' : '';
    if (!langString) {
      return '<pre><code>'
        + (escaped ? code : escapeHtmlEntities(code, true))
        + '</code></pre>\n';
    }
    return '<pre><code class="language-'
      + escapeHtmlEntities(langString)
      + '">'
      + (escaped ? code : escapeHtmlEntities(code, true))
      + '</code></pre>\n';
  },

  blockquote({ tokens }, parser) {
    const body = parser.parse(tokens);
    return `<blockquote>\n${body}</blockquote>\n`;
  },

  html({ text }) {
    return text;
  },

  def() {
    return '';
  },

  heading({ tokens, depth }, parser) {
    return `<h${depth}>${parser.parseInline(tokens)}</h${depth}>\n`;
  },

  hr() {
    return '<hr>\n';
  },

  list(token, parser) {
    const ordered = token.ordered;
    const start = token.start;
    let body = '';
    for (let j = 0; j < token.items.length; j++) {
      body += renderer.listitem(token.items[j], parser);
    }
    const type = ordered ? 'ol' : 'ul';
    const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
    return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
  },

  listitem(item, parser) {
    return `<li>${parser.parse(item.tokens)}</li>\n`;
  },

  checkbox({ checked }) {
    return '<input '
      + (checked ? 'checked="" ' : '')
      + 'disabled="" type="checkbox"> ';
  },

  paragraph({ tokens }, parser) {
    return `<p>${parser.parseInline(tokens)}</p>\n`;
  },

  table(token, parser) {
    let header = '';
    let cell = '';
    for (let j = 0; j < token.header.length; j++) {
      cell += renderer.tablecell(token.header[j], parser);
    }
    header += renderer.tablerow({ text: cell });

    let body = '';
    for (let j = 0; j < token.rows.length; j++) {
      const row = token.rows[j];
      cell = '';
      for (let k = 0; k < row.length; k++) {
        cell += renderer.tablecell(row[k], parser);
      }
      body += renderer.tablerow({ text: cell });
    }
    if (body) body = `<tbody>${body}</tbody>`;

    return '<table>\n'
      + '<thead>\n'
      + header
      + '</thead>\n'
      + body
      + '</table>\n';
  },

  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  },

  tablecell(token, parser) {
    const content = parser.parseInline(token.tokens);
    const type = token.header ? 'th' : 'td';
    const tag = token.align
      ? `<${type} align="${token.align}">`
      : `<${type}>`;
    return tag + content + `</${type}>\n`;
  },

  strong({ tokens }, parser) {
    return `<strong>${parser.parseInline(tokens)}</strong>`;
  },

  em({ tokens }, parser) {
    return `<em>${parser.parseInline(tokens)}</em>`;
  },

  codespan({ text }) {
    return `<code>${escapeHtmlEntities(text, true)}</code>`;
  },

  br() {
    return '<br>';
  },

  del({ tokens }, parser) {
    return `<del>${parser.parseInline(tokens)}</del>`;
  },

  link({ href, title, text, tokens, autolink }, parser) {
    const parsedText = autolink
      ? escapeHtmlEntities(text, true)
      : parser.parseInline(tokens);
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return parsedText;
    }
    href = escapeHtmlEntities(cleanHref, autolink);
    let out = '<a href="' + href + '"';
    if (title) {
      out += ' title="' + (escapeHtmlEntities(title)) + '"';
    }
    out += '>' + parsedText + '</a>';
    return out;
  },

  image({ href, title, text, tokens }, parser) {
    if (tokens) {
      text = parser.parseInline(tokens, textRenderer);
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return escapeHtmlEntities(text);
    }
    href = cleanHref;
    let out = `<img src="${escapeHtmlEntities(href)}" alt="${escapeHtmlEntities(text)}"`;
    if (title) {
      out += ` title="${escapeHtmlEntities(title)}"`;
    }
    out += '>';
    return out;
  },

  text(token, parser) {
    return 'tokens' in token && token.tokens
      ? parser.parseInline(token.tokens)
      : ('escaped' in token && token.escaped ? token.text : escapeHtmlEntities(token.text));
  },
};

const parser = {
  parse(tokens) {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      switch (token.type) {
        case 'space': out += renderer.space(token, parser); break;
        case 'hr': out += renderer.hr(token, parser); break;
        case 'heading': out += renderer.heading(token, parser); break;
        case 'code': out += renderer.code(token, parser); break;
        case 'table': out += renderer.table(token, parser); break;
        case 'blockquote': out += renderer.blockquote(token, parser); break;
        case 'list': out += renderer.list(token, parser); break;
        case 'checkbox': out += renderer.checkbox(token, parser); break;
        case 'html': out += renderer.html(token, parser); break;
        case 'def': out += renderer.def(token, parser); break;
        case 'paragraph': out += renderer.paragraph(token, parser); break;
        case 'text': out += renderer.text(token, parser); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  },

  parseInline(tokens, rend = renderer) {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      switch (token.type) {
        case 'escape': out += rend.text(token, parser); break;
        case 'html': out += rend.html(token, parser); break;
        case 'link': out += rend.link(token, parser); break;
        case 'image': out += rend.image(token, parser); break;
        case 'checkbox': out += rend.checkbox(token, parser); break;
        case 'strong': out += rend.strong(token, parser); break;
        case 'em': out += rend.em(token, parser); break;
        case 'codespan': out += rend.codespan(token, parser); break;
        case 'br': out += rend.br(token, parser); break;
        case 'del': out += rend.del(token, parser); break;
        case 'text': out += rend.text(token, parser); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type '
      + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return parser.parse(tokens);
}
