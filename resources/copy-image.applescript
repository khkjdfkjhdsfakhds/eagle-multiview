use framework "Foundation"
use framework "AppKit"
use scripting additions

on run argv
	set sourcePath to item 1 of argv
	set pasteboardType to item 2 of argv
	set fileListXML to item 3 of argv
	set pasteboard to current application's NSPasteboard's generalPasteboard()
	set sourceImage to current application's NSImage's alloc()'s initWithContentsOfFile:sourcePath
	if sourceImage is missing value then error "无法读取图片文件"
	set imageData to sourceImage's TIFFRepresentation
	pasteboard's clearContents()
	pasteboard's setData:imageData forType:pasteboardType
	pasteboard's setString:fileListXML forType:"NSFileContentsPboardType"
	pasteboard's setString:fileListXML forType:"NSFilenamesPboardType"
end run
