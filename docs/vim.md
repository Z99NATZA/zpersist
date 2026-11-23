# Vim mode

[Documentation index](README.md)

## Overview

```text
Enable Vim
==========

Turn on Vim in the header, then focus the SQL editor. The editor starts in
Normal mode. The header switch remembers your preference in this browser.
The status tag color identifies the current Vim mode. The editor uses its blue
theme for the cursor and selection in every Vim mode.

Key notation
----------

Keys are case-sensitive. A sequence such as gg means press g twice. A count
before a motion or edit repeats it, as in 3j or 2dd. Modifier shortcuts work
when the browser or operating system passes them to the editor.
```

[Replit's CodeMirror Vim keymap and Ex commands](https://github.com/replit/codemirror-vim/blob/master/packages/codemirror-vim-core/vim.js)

## Modes

| Key | Status | Tag color | Action |
|---|---|---|---|
| `Esc` or `Ctrl+[` | `NORMAL` | Blue | Return to Normal mode from Insert, Replace, or Visual mode |
| `i`, `I`, `a`, `A`, `o`, `O` | `INSERT` | Green | Start inserting text |
| `v` | `VISUAL` | Purple | Select characters |
| `V` | `VISUAL LINE` | Amber | Select whole lines |
| `Ctrl+V` or `Ctrl+Q` | `VISUAL BLOCK` | Pink | Select a rectangular block |
| `R` | `REPLACE` | Red | Overwrite characters as you type |
| `:`, `/`, `?` | Command or search prompt | | Open an Ex command, forward search, or backward search prompt |

## Navigation

| Key | Action |
|---|---|
| `h`, `j`, `k`, `l` or arrow keys | Move left, down, up, or right |
| `Backspace`, `Space`, `Ctrl+N`, `Ctrl+P` | Move left, right, down, or up in Normal mode |
| `w`, `b`, `e`, `ge` | Move to the next word start, previous word start, next word end, or previous word end |
| `W`, `B`, `E`, `gE` | Use the corresponding word motions with whitespace as the delimiter |
| `0`, `^`, `$` | Go to the line start, first nonblank character, or line end. `Home` and `End` also go to the line boundaries |
| `12\|` | Move to column 12 |
| `gj`, `gk`, `g0`, `g^`, `g$` | Move by displayed lines or to a displayed line boundary |
| `gg`, `G`, `12G` | Go to the first line, last line, or line 12 |
| `+`, `-`, `Enter` | Go to the first nonblank character of the next or previous line. `Enter` moves forward |
| `(`, `)`, `{`, `}` | Move by sentence or paragraph |
| `%` | Jump to a matching bracket |
| `f{char}`, `F{char}` | Find a character forward or backward on the current line |
| `t{char}`, `T{char}` | Move up to a character forward or backward on the current line |
| `;`, `,` | Repeat the last character search in the same or opposite direction |
| `H`, `M`, `L` | Move to the top, middle, or bottom line of the viewport |
| `Ctrl+F`, `Ctrl+B`, `Ctrl+D`, `Ctrl+U` | Move down or up a full or half page. `PageDown` and `PageUp` move a full page |
| `Ctrl+E`, `Ctrl+Y` | Scroll down or up a line |
| `zt`, `zz`, `zb` | Scroll the current line to the top, center, or bottom of the viewport |
| `m{mark}`, `'{mark}`, `` `{mark} `` | Set a mark, jump to its line, or jump to its exact position |
| `Ctrl+O`, `Ctrl+I` | Move backward or forward in the jump list from Normal mode |

## Editing and selection

| Mode | Key | Action |
|---|---|---|
| Normal | `i`, `I`, `a`, `A` | Insert at the cursor, at the first nonblank character, after the cursor, or at the end of the line. The `Insert` key also enters Insert mode |
| Normal | `o`, `O` | Open a line below or above and enter Insert mode |
| Normal | `gi`, `gI` | Start inserting at the last edit position or the start of the current line |
| Normal | `x`, `X`, `r{char}` | Delete under the cursor, delete before it, or replace one character. `Delete` also deletes under the cursor |
| Normal | `d{motion}`, `c{motion}`, `y{motion}` | Delete, change, or yank text covered by a motion, such as `dw`, `ciw`, or `y$` |
| Normal | `dd`, `cc`, `yy` | Delete, change, or yank a whole line |
| Normal | `D`, `C`, `Y` | Delete to the line end, change to the line end, or yank the whole line |
| Normal | `s`, `S` | Change the current character or the whole line |
| Normal | `p`, `P` | Put text from a register after or before the cursor |
| Normal, Visual | `J`, `gJ` | Join lines with standard spacing or join them as written |
| Normal, Visual | `gq`, `gw` | Reflow text to the configured width. `gw` keeps the cursor in place |
| Normal | `u`, `Ctrl+R`, `.` | Undo, redo, or repeat the last edit |
| Normal | `Ctrl+A`, `Ctrl+X` | Increase or decrease a number |
| Normal, Visual | `>`, `<`, `>>`, `<<` | Indent or outdent the selected lines or the lines covered by a motion. Doubling the operator acts on the current line |
| Normal, Visual | `~`, `gu`, `gU`, `g~` | Toggle case or apply lowercase, uppercase, or case toggle as an operator |
| Normal, Visual | `"{register}` | Choose a register for an operation, such as `"ayy` to yank a line and `"ap` to put it |
| Normal, Visual | `iw`, `aw`, `iW`, `aW`, `i(`, `a(`, `i[`, `a[`, `i"`, `a"`, `ip`, `ap` | Use inner or surrounding text objects for words, brackets, quotes, or paragraphs. In Normal mode, use them after an operator |
| Normal, Visual | `gv` | Restore the previous Visual selection |
| Visual | `d`, `c`, `y`, `p` | Delete, change, yank, or replace the selection with text from a register |
| Visual | `o`, `O` | Move to the other end of the selection or to the opposite corner on the same line in block mode |
| Visual | `u`, `U` | Convert the selection to lowercase or uppercase |
| Insert, Replace | `Ctrl+O` | Execute one Normal-mode command, then enter Insert mode |
| Insert, Replace | `Ctrl+R` followed by a register | Insert text from that register |
| Insert, Replace | `Ctrl+W`, `Ctrl+U` | Delete back to the previous word start or line start |
| Insert, Replace | `Ctrl+T`, `Ctrl+D`, `Insert` | Indent, outdent, or switch between Insert and Replace |
| Normal | `q{register}`, `q`, `@{register}`, `@@` | Start recording a macro, stop recording, replay a macro, or replay the last macro |

## Search and commands

| Key or command | Action |
|---|---|
| `/pattern`, `?pattern` then `Enter` | Search forward or backward in the SQL editor |
| `*`, `#`, `g*`, `g#` | Search forward or backward for the word under the cursor. The `g` variants allow partial matches |
| `n`, `N`, `gn`, `gN` | Repeat the search in the same or opposite direction, or select a match with a `g` variant |
| `Esc` | Dismiss the command or search prompt |
| `:noh` | Clear search highlighting |
| `:s/old/new/g`, `:%s/old/new/g` | Replace all matches on the current line or across the editor |
| `:12` | Jump to line 12 |
| `:sort`, `:d`, `:j`, `:y`, `:put` | Sort, delete, join, yank, or put text. Use a line range where applicable |
| `:u`, `:red`, `:start` | Undo, redo, or enter Insert mode |
| `:marks`, `:reg` | Show marks or registers |
| `:map`, `:nmap`, `:imap`, `:vmap`, `:unmap` | Define or remove a key mapping |

## Running SQL

```text
Query execution
==========

Choose a database or start the SQL with USE. With a selection, Run sends
only the selected text. Otherwise it sends the whole editor contents.

SQL drafts
----------

The editor saves drafts automatically as you edit them.
```

| Shortcut or control | Action |
|---|---|
| `Ctrl+Enter` or `Cmd+Enter` | Run SQL with focus in the editor, including in a Visual mode |
| **Run** | Run the same SQL from the toolbar |
