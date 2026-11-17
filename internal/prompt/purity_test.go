package prompt

import "testing"

func TestCheckTraitViolations(t *testing.T) {
	clean := "粗黑钢笔勾线，略微颤抖的手绘轮廓，暖白纸面水彩晕染，少量朱红点缀色，大面积留白。"
	if got := CheckTraitViolations(clean); len(got) != 0 {
		t.Fatalf("clean zh traits flagged: %v", got)
	}
	cleanEn := "Minimalist editorial ink linework, warm off-white paper grain, muted vermilion accent, manual wash texture."
	if got := CheckTraitViolations(cleanEn); len(got) != 0 {
		t.Fatalf("clean en traits flagged (word boundary check): %v", got)
	}
	dirty := "白色长裙的年轻女孩站在花田里手里拿着咖啡杯和雨伞，a woman wearing a dress with a coffee cup"
	got := CheckTraitViolations(dirty)
	if len(got) < 5 {
		t.Fatalf("expected subject violations, got %v", got)
	}
}
