package config

// GeometryProfile holds explicit measurements. An omitted value stays unknown;
// paper size and protocol names never establish printable dot counts.
type GeometryProfile struct {
	PrintableWidthDots  int      `json:"printable_width_dots" yaml:"printable_width_dots"`
	PrintableHeightDots *int     `json:"printable_height_dots,omitempty" yaml:"printable_height_dots,omitempty"`
	DPIX                *int     `json:"dpi_x,omitempty" yaml:"dpi_x,omitempty"`
	DPIY                *int     `json:"dpi_y,omitempty" yaml:"dpi_y,omitempty"`
	PaperWidthMM        *float64 `json:"paper_width_mm,omitempty" yaml:"paper_width_mm,omitempty"`
	PaperHeightMM       *float64 `json:"paper_height_mm,omitempty" yaml:"paper_height_mm,omitempty"`
	OffsetXDots         *int     `json:"offset_x_dots,omitempty" yaml:"offset_x_dots,omitempty"`
	OffsetYDots         *int     `json:"offset_y_dots,omitempty" yaml:"offset_y_dots,omitempty"`
	RasterCommand       string   `json:"raster_command,omitempty" yaml:"raster_command,omitempty"`
}
