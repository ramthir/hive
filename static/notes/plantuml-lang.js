export const plantUmlMode = {
  name: 'plantuml',
  startState() {
    return {
      inBlockComment: false,
    };
  },
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match(/.*?\*\//) || stream.match(/.*?\'\//)) {
        state.inBlockComment = false;
        return 'comment';
      }
      stream.skipToEnd();
      return 'comment';
    }

    if (stream.eatSpace()) return null;

    // Start of block comment /' ... '/
    if (stream.match(/^\/\'/)) {
      if (!stream.match(/.*?\'\//)) {
        state.inBlockComment = true;
      }
      return 'comment';
    }

    // Single-line comment starting with single quote '
    if (stream.match(/^'.*/)) {
      return 'comment';
    }

    // Strings with double quotes
    if (stream.match(/^"([^"\\]|\\.)*"/)) {
      return 'string';
    }
    if (stream.match(/^"[^"]*/)) {
      return 'string';
    }

    // PlantUML directives (@startuml, @enduml, @startmindmap, etc.)
    if (stream.match(/^@[a-zA-Z]+/)) {
      return 'meta';
    }

    // Preprocessor directives (!include, !define, !theme, !ifdef, etc.)
    if (stream.match(/^![a-zA-Z_]+/)) {
      return 'meta';
    }

    // Processing instructions (<?plantuml ... ?>)
    if (stream.match(/^<\?plantuml.*?\?>/i)) {
      return 'meta';
    }

    // Stereotypes (<<Service>>, <<Database>>, etc.)
    if (stream.match(/^<<[^>]+>>/)) {
      return 'typeName';
    }

    // Links: [[url label]]
    if (stream.match(/^\[\[[^\]]+\]\]/)) {
      return 'link';
    }

    // Creole/HTML formatting tags (<b>, </i>, <color:...>, </color>, <font:...>, etc.)
    if (stream.match(/^<\/?[a-zA-Z_]+(?::[^>]+)?>/)) {
      return 'tag';
    }

    // Arrows and connectors (->, -->, <-, <--, <->, <--> ->>, <<-, --*, *--, --o, o--, <|--, --|>, <|.., ..|>, .., --, ==)
    // Also arrows with direction or color tags (-[#red]->, -[hidden]->, -up->, -down->, -left->, -right->)
    if (stream.match(/^<?[-.=]+(?:\[(?:#[a-zA-Z0-9]+|[a-zA-Z0-9_, -]+)\])?[-.=]*>?/)) {
      return 'operator';
    }

    // Color definitions (#FFFFFF, #red, #aliceblue)
    if (stream.match(/^#(?:[0-9a-fA-F]{3,8}|[a-zA-Z_]+)\b/)) {
      return 'atom';
    }

    // Structural element declarations
    if (stream.match(/^(?:actor|participant|boundary|control|entity|database|collections|queue|class|interface|abstract|enum|package|namespace|folder|frame|cloud|node|artifact|component|storage|agent|rectangle|card|state|usecase|object|map|diamond|circle|file|stack|partition|archimate)\b/i)) {
      return 'keyword';
    }

    // Control flow and diagram keywords
    if (stream.match(/^(?:alt|else|opt|loop|par|break|critical|group|end|box|as|is|then|fork|again|split|repeat|while|detach|kill|start|stop|note|rnote|hnote|ref|over|of|activate|deactivate|destroy|create|return|autonumber|skinparam|skin|scale|title|caption|header|footer|legend|center|left|right|top|bottom|hide|show|remove|restore)\b/i)) {
      return 'keyword';
    }

    // Visibility modifiers
    if (stream.match(/^[+\-#~]\b/)) {
      return 'attribute';
    }

    // Numbers
    if (stream.match(/^[0-9]+(?:\.[0-9]+)?\b/)) {
      return 'number';
    }

    // Identifiers
    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
      return 'variableName';
    }

    // Punctuation and brackets
    if (stream.match(/^[{}()[\]:,;]/)) {
      return 'punctuation';
    }

    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "'" },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"', '<<'] },
  },
};

export const createPlantUmlLanguage = (StreamLanguage) => StreamLanguage.define(plantUmlMode);
