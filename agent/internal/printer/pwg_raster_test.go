package printer

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"testing"
)

// Independent page decoder for tests; verifies PWG 5102.4 row repetition,
// pixel PackBits, channel counts, and page boundaries without using encoder
// helper routines. This catches incorrectly labeled raw RGB/PDF as PWG.
func decodeTestPWGPage(stream []byte, at int) ([][]byte, int, error) {
	if at+pwgPageHeaderBytes > len(stream) {
		return nil, at, fmt.Errorf("truncated page header")
	}
	hdr := stream[at : at+pwgPageHeaderBytes]
	w := int(binary.BigEndian.Uint32(hdr[372:376]))
	h := int(binary.BigEndian.Uint32(hdr[376:380]))
	ch := int(binary.BigEndian.Uint32(hdr[420:424]))
	if w <= 0 || h <= 0 || ch <= 0 || w > 1000 || h > 1000 || ch > 3 {
		return nil, at, fmt.Errorf("invalid test page geometry")
	}
	pos := at + pwgPageHeaderBytes
	rows := make([][]byte, 0, h)
	for len(rows) < h {
		if pos >= len(stream) {
			return nil, pos, fmt.Errorf("truncated row prefix")
		}
		identicalRows := int(stream[pos]) + 1
		pos++
		row := make([]byte, 0, w*ch)
		for len(row) < w*ch {
			if pos >= len(stream) {
				return nil, pos, fmt.Errorf("truncated PackBits")
			}
			code := int(int8(stream[pos]))
			pos++
			if code >= 0 {
				if pos+ch > len(stream) {
					return nil, pos, fmt.Errorf("truncated duplicate pixel")
				}
				for i := 0; i < code+1; i++ {
					row = append(row, stream[pos:pos+ch]...)
				}
				pos += ch
			} else {
				n := 1 - code
				if pos+n*ch > len(stream) {
					return nil, pos, fmt.Errorf("truncated literal run")
				}
				row = append(row, stream[pos:pos+n*ch]...)
				pos += n*ch
			}
			if len(row) > w*ch {
				return nil, pos, fmt.Errorf("row overrun")
			}
		}
		for i := 0; i < identicalRows; i++ {
			rows = append(rows, append([]byte(nil), row...))
		}
		if len(rows) > h {
			return nil, pos, fmt.Errorf("row count overrun")
		}
	}
	return rows, pos, nil
}

func TestPWGRasterEncodesGrayRowsAndNetworkByteOrder(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for y := 0; y < 3; y++ {
		for x := 0; x < 4; x++ {
			value := uint8(0)
			if x >= 2 { value = 255 }
			img.SetRGBA(x, y, color.RGBA{R:value,G:value,B:value,A:255})
		}
	}
	var out bytes.Buffer
	out.WriteString("RaS2")
	if err := encodePWGPage(&out, img, 300, 2, 72, 54, pwgGray8); err != nil { t.Fatal(err) }
	p := out.Bytes()
	if !bytes.Equal(p[:4], []byte("RaS2")) || !bytes.Equal(p[4:13], []byte("PwgRaster")) { t.Fatal("invalid PWG document/page magic") }
	hdr := p[4:4+pwgPageHeaderBytes]
	for _, tc := range []struct { off int; want uint32 }{
		{276,300},{280,300},{352,72},{356,54},{372,4},{376,3},
		{384,8},{388,8},{392,4},{396,0},{400,18},{420,1},{452,2},{456,1},{460,1},
	} {
		got := binary.BigEndian.Uint32(hdr[tc.off:tc.off+4])
		if got != tc.want { t.Errorf("PWG header[%d]=%d, want %d",tc.off,got,tc.want) }
	}
	rows, end, err := decodeTestPWGPage(p, 4)
	if err != nil { t.Fatal(err) }
	if len(rows)!=3 || end != len(p) { t.Fatalf("page rows=%d, end=%d, total=%d",len(rows),end,len(p)) }
	for y,row := range rows {
		if !bytes.Equal(row, []byte{0,0,255,255}) {
			t.Fatalf("line %d decoded %x",y,row)
		}
	}
	// One repeated run for all 3 equal rows.
	if got := p[4+pwgPageHeaderBytes]; got != 2 { t.Fatalf("row run code=%d, want 2",got) }
}

func TestPWGRasterRoundTripsLiteralPixelsAndTwoPages(t *testing.T) {
	var out bytes.Buffer
	out.WriteString("RaS2")
	for page := 0; page < 2; page++ {
		img := image.NewRGBA(image.Rect(0,0,257,2))
		for y:=0;y<2;y++ {
			for x:=0;x<257;x++ {
				img.SetRGBA(x,y,color.RGBA{R:uint8(x+page),G:uint8((x*3)+y),B:uint8(255-x),A:255})
			}
		}
		if err := encodePWGPage(&out,img,300,2,72,72,pwgRGB8); err!=nil { t.Fatal(err) }
	}
	pos := 4
	for page:=0; page<2;page++ {
		if got:=binary.BigEndian.Uint32(out.Bytes()[pos+400:pos+404]); got!=19 { t.Fatalf("page %d has wrong sRGB space %d",page,got) }
		rows,next,err:=decodeTestPWGPage(out.Bytes(),pos)
		if err!=nil { t.Fatal(err) }
		for y,row:=range rows {
			for x:=0;x<257;x++ {
				want:=[]byte{uint8(x+page),uint8(x*3+y),uint8(255-x)}
				if !bytes.Equal(row[x*3:x*3+3],want) {t.Fatalf("page=%d x=%d y=%d got=%x want=%x",page,x,y,row[x*3:x*3+3],want)}
			}
		}
		pos=next
	}
	if pos!=out.Len() { t.Fatalf("extra bytes after two pages: %d",out.Len()-pos) }
}

func TestPWGOptionsHonourDeviceCapabilities(t *testing.T) {
	cases:=[]struct{attrs map[string]string;dpi int;mode pwgRasterColor;fails bool}{
		{nil,300,pwgGray8,false},
		{map[string]string{"pwg-raster-document-resolution-supported":"600x600dpi,150x150dpi,300x300dpi",
			"pwg-raster-document-type-supported":"srgb_8,sgray_8"},300,pwgGray8,false},
		{map[string]string{"pwg-raster-document-resolution-supported":"600x600dpi",
			"pwg-raster-document-type-supported":"srgb_8"},600,pwgRGB8,false},
		{map[string]string{"pwg-raster-document-resolution-supported":"300x200dpi"},0,pwgGray8,true},
		{map[string]string{"pwg-raster-document-type-supported":"sgray_1"},0,pwgGray8,true},
	}
	for i,tc:=range cases {
		dpi,mode,err:=pwgOptionsFromIPPAttributes(tc.attrs)
		if (err!=nil)!=tc.fails { t.Fatalf("case %d error=%v",i,err) }
		if !tc.fails && (dpi!=tc.dpi||mode!=tc.mode) { t.Errorf("case %d dpi=%d mode=%d",i,dpi,mode) }
	}
}
