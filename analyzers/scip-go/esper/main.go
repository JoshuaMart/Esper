// Command esper-scip-go runs scip-go inside Esper's analyzer contract: `fetch` downloads the
// modules of the snapshot, with the network, and `analyze` indexes it with scip-go, without the
// network, and writes what the index says in Esper's import format.
//
// The snapshot's source is at /esper/src, read-only; /esper/input.json lists its files and
// modules; the result goes to /esper/out/analysis.jsonl.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/scip-code/scip/bindings/go/scip"
	"google.golang.org/protobuf/proto"
)

const (
	src    = "/esper/src"
	input  = "/esper/input.json"
	output = "/esper/out/analysis.jsonl"
	format = 1
)

type module struct {
	Path string `json:"path"`
	Dir  string `json:"dir"`
}

type request struct {
	Analyzer struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"analyzer"`
	Snapshot struct {
		Files   []string `json:"files"`
		Modules []module `json:"modules"`
	} `json:"snapshot"`
}

func main() {
	if len(os.Args) != 2 {
		fail("usage: esper-scip-go fetch|analyze")
	}
	var req request
	data, err := os.ReadFile(input)
	if err != nil {
		fail(err.Error())
	}
	if err := json.Unmarshal(data, &req); err != nil {
		fail(fmt.Sprintf("%s: %v", input, err))
	}
	switch os.Args[1] {
	case "fetch":
		fetch(req)
	case "analyze":
		analyze(req)
	default:
		fail("usage: esper-scip-go fetch|analyze")
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "esper-scip-go:", message)
	os.Exit(1)
}

// The go command, with what the image's environment sets: no toolchain download, no version
// control, no cgo, and go.mod and go.sum never written.
func run(dir string, args ...string) {
	cmd := exec.Command("go", args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fail(fmt.Sprintf("go %s in %s: %v", strings.Join(args, " "), dir, err))
	}
}

func fetch(req request) {
	for _, m := range req.Snapshot.Modules {
		run(filepath.Join(src, m.Dir), "mod", "download")
	}
}

// A place in a file of the snapshot, as the import format states it: 1-based line, and 1-based
// column in UTF-8 bytes.
type place struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
}

type target struct {
	*place
	External string `json:"external,omitempty"`
}

type line struct {
	Type    string  `json:"type"`
	At      *place  `json:"at,omitempty"`
	Name    string  `json:"name,omitempty"`
	Target  *target `json:"target,omitempty"`
	Of      *target `json:"of,omitempty"`
	Format  int     `json:"format,omitempty"`
	Version string  `json:"version,omitempty"`
}

type definition struct {
	at   place
	name string
}

func analyze(req request) {
	files := map[string]bool{}
	for _, f := range req.Snapshot.Files {
		files[f] = true
	}
	// Every module's index: documents are relative to the module's folder.
	type document struct {
		path string
		doc  *scip.Document
	}
	var documents []document
	for i, m := range req.Snapshot.Modules {
		out := fmt.Sprintf("/tmp/index-%d.scip", i)
		cmd := exec.Command("scip-go", "index", "--quiet", "--skip-tests",
			"--module-version=snapshot", "--output", out)
		cmd.Dir = filepath.Join(src, m.Dir)
		cmd.Stdout = os.Stderr
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			fail(fmt.Sprintf("scip-go in %s: %v", m.Dir, err))
		}
		data, err := os.ReadFile(out)
		if err != nil {
			fail(err.Error())
		}
		var index scip.Index
		if err := proto.Unmarshal(data, &index); err != nil {
			fail(fmt.Sprintf("%s: %v", out, err))
		}
		for _, doc := range index.GetDocuments() {
			documents = append(documents, document{path.Join(m.Dir, doc.GetRelativePath()), doc})
		}
	}

	lines := map[string][]string{}
	text := func(file string) []string {
		if l, ok := lines[file]; ok {
			return l
		}
		data, err := os.ReadFile(filepath.Join(src, file))
		if err != nil {
			fail(err.Error())
		}
		l := strings.Split(string(data), "\n")
		lines[file] = l
		return l
	}
	// SCIP's offsets in the document's encoding, as UTF-8 bytes.
	at := func(file string, doc *scip.Document, pos scip.Position) place {
		l := text(file)
		column := int(pos.Character)
		if int(pos.Line) < len(l) {
			column = utf8Column(l[pos.Line], column, doc.GetPositionEncoding())
		}
		return place{file, int(pos.Line) + 1, column + 1}
	}

	// Where each symbol of the snapshot is defined, and what kind of symbol it is.
	defined := map[string]definition{}
	known := map[string]bool{}
	specifications := map[string]bool{}
	for _, d := range documents {
		for _, info := range d.doc.GetSymbols() {
			if info.GetKind() == scip.SymbolInformation_MethodSpecification {
				specifications[info.GetSymbol()] = true
			}
		}
		for _, occ := range d.doc.GetOccurrences() {
			if occ.GetSymbolRoles()&int32(scip.SymbolRole_Definition) == 0 {
				continue
			}
			known[occ.GetSymbol()] = true
			if !files[d.path] {
				continue
			}
			r, ok := occ.SourceRange()
			if !ok {
				continue
			}
			defined[occ.GetSymbol()] = definition{at(d.path, d.doc, r.Start), ""}
		}
	}
	// The function or method a symbol names, with its name and, outside the module, its
	// reference: `net/http#Request.FormValue`. A method of an interface of the module is a term
	// whose kind says so.
	callable := func(symbol string) (name string, external string, ok bool) {
		if scip.IsLocalSymbol(symbol) {
			return "", "", false
		}
		parsed, err := scip.ParseSymbol(symbol)
		if err != nil || len(parsed.Descriptors) == 0 {
			return "", "", false
		}
		last := parsed.Descriptors[len(parsed.Descriptors)-1]
		if last.Suffix != scip.Descriptor_Method &&
			(last.Suffix != scip.Descriptor_Term || !specifications[symbol]) {
			return "", "", false
		}
		var pkg string
		var names []string
		for _, d := range parsed.Descriptors {
			if d.Suffix == scip.Descriptor_Namespace {
				pkg = d.Name
			} else {
				names = append(names, d.Name)
			}
		}
		if pkg == "" {
			return "", "", false
		}
		return last.Name, pkg + "#" + strings.Join(names, "."), true
	}
	targetOf := func(symbol string) (*target, string, bool) {
		name, external, ok := callable(symbol)
		if !ok {
			return nil, "", false
		}
		if def, ok := defined[symbol]; ok {
			p := def.at
			return &target{place: &p}, name, true
		}
		// Defined in the target but in a file the snapshot does not hold: nothing to cite.
		if known[symbol] {
			return nil, "", false
		}
		return &target{External: external}, name, true
	}

	out := []line{}
	for _, d := range documents {
		if !files[d.path] {
			continue
		}
		for _, occ := range d.doc.GetOccurrences() {
			if occ.GetSymbolRoles()&int32(scip.SymbolRole_Definition) != 0 {
				continue
			}
			t, name, ok := targetOf(occ.GetSymbol())
			if !ok {
				continue
			}
			r, ok := occ.SourceRange()
			if !ok {
				continue
			}
			p := at(d.path, d.doc, r.Start)
			out = append(out, line{Type: "reference", At: &p, Name: name, Target: t})
		}
		for _, info := range d.doc.GetSymbols() {
			def, ok := defined[info.GetSymbol()]
			name, _, callableOk := callable(info.GetSymbol())
			if !ok || !callableOk {
				continue
			}
			for _, rel := range info.GetRelationships() {
				if !rel.GetIsImplementation() {
					continue
				}
				// Only interfaces of the snapshot: a call through one outside it stays a call to
				// that symbol.
				of, _, ok := targetOf(rel.GetSymbol())
				if !ok || of.place == nil {
					continue
				}
				p := def.at
				out = append(out, line{Type: "implementation", At: &p, Name: name, Of: of})
			}
		}
	}

	encoded := make([]string, 0, len(out))
	for _, l := range out {
		data, err := json.Marshal(l)
		if err != nil {
			fail(err.Error())
		}
		encoded = append(encoded, string(data))
	}
	sort.Strings(encoded)
	encoded = dedupe(encoded)

	file, err := os.Create(output)
	if err != nil {
		fail(err.Error())
	}
	w := bufio.NewWriter(file)
	header, _ := json.Marshal(struct {
		Type    string `json:"type"`
		Format  int    `json:"format"`
		Name    string `json:"name"`
		Version string `json:"version"`
	}{"analyzer", format, req.Analyzer.Name, req.Analyzer.Version})
	fmt.Fprintln(w, string(header))
	for _, l := range encoded {
		fmt.Fprintln(w, l)
	}
	if err := w.Flush(); err != nil {
		fail(err.Error())
	}
	if err := file.Close(); err != nil {
		fail(err.Error())
	}
}

func dedupe(sorted []string) []string {
	out := sorted[:0]
	for i, s := range sorted {
		if i == 0 || s != sorted[i-1] {
			out = append(out, s)
		}
	}
	return out
}

// A column in the document's position encoding, as UTF-8 bytes from the start of the line.
func utf8Column(text string, column int, encoding scip.PositionEncoding) int {
	switch encoding {
	case scip.PositionEncoding_UTF16CodeUnitOffsetFromLineStart:
		units := 0
		for i, r := range text {
			if units >= column {
				return i
			}
			units += len(utf16.Encode([]rune{r}))
		}
		return len(text)
	case scip.PositionEncoding_UTF32CodeUnitOffsetFromLineStart:
		if column > utf8.RuneCountInString(text) {
			return len(text)
		}
		return len([]byte(string([]rune(text)[:column])))
	default:
		return column
	}
}
