package prompt

import (
	"regexp"
	"strings"
)

// subjectTermsZh lists concrete subjects, clothing, props, animals and places
// that must not leak into a style's reusable visual-language traits.
var subjectTermsZh = []string{
	"女孩", "女生", "少女", "女性", "女人", "男生", "男孩", "少年", "男性", "男人",
	"老人", "老奶奶", "老爷爷", "小孩", "婴儿", "宇航员", "模特", "人物穿搭",
	"长裙", "短裙", "连衣裙", "旗袍", "西装", "牛仔裤", "卫衣", "风衣", "帽子", "眼镜",
	"短发", "长发", "马尾", "卷发", "回眸", "微笑", "奔跑", "站立", "坐着",
	"咖啡杯", "雨伞", "书包", "手机", "自行车", "猫咪", "小狗", "小猫", "兔子",
	"花田", "向日葵", "樱花树", "咖啡馆", "教室", "办公室", "海边", "雪山", "湖泊", "森林",
}

var subjectTermsEn = []string{
	"girl", "woman", "women", "female", "boy", "man", "men", "male", "teenager", "elderly",
	"astronaut", "dress", "skirt", "qipao", "suit", "jeans", "hoodie", "umbrella",
	"coffee cup", "short hair", "long hair", "ponytail", "cat", "dog", "bunny",
	"flower field", "sunflower", "cafe", "coffee shop", "classroom", "office", "beach", "mountain",
}

var subjectEnRe = compileEnSubjects()

func compileEnSubjects() []*regexp.Regexp {
	out := make([]*regexp.Regexp, 0, len(subjectTermsEn))
	for _, term := range subjectTermsEn {
		out = append(out, regexp.MustCompile(`(?i)\b`+regexp.QuoteMeta(term)+`\b`))
	}
	return out
}

// CheckTraitViolations returns concrete subject/scene tokens found in style traits.
// An empty slice means the traits describe pure visual language.
func CheckTraitViolations(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	seen := map[string]bool{}
	var hits []string
	add := func(tok string) {
		key := strings.ToLower(tok)
		if !seen[key] {
			seen[key] = true
			hits = append(hits, tok)
		}
	}
	for _, w := range subjectTermsZh {
		if strings.Contains(text, w) {
			add(w)
		}
	}
	for i, re := range subjectEnRe {
		if re.MatchString(text) {
			add(subjectTermsEn[i])
		}
	}
	return hits
}
