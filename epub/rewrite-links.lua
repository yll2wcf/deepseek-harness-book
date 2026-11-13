-- Build chapter links for the combined document; publication URLs stay pinned.
function Pandoc(doc)
  local headings = {}
  for _, file in ipairs(PANDOC_STATE.input_files) do
    local handle = io.open(file, "r")
    if handle then
      local parsed = pandoc.read(handle:read("*a"), "gfm")
      handle:close()
      for _, block in ipairs(parsed.blocks) do
        if block.t == "Header" and block.level == 1 then
          headings[file:match("([^/]+)$")] = block.identifier
          break
        end
      end
    end
  end
  return doc:walk({Link = function(link)
    local target = link.target
    if target:match("^%a[%w+.-]*:") or target:sub(1, 1) == "#" then return link end
    local name = target:match("([^/]+%.md)$")
    if name and headings[name] then
      link.target = "#" .. headings[name]
      return link
    end
    -- Editorial records and historical lab directories are not ebook sections.
    return link.content
  end})
end
