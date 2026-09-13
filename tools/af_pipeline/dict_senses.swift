// 系统词典完整词条批量查询（工序化加注消歧的数据源，零网络零进程依赖除 swift 本身）
// 用法：swift dict_senses.swift word1,word2,...   → stdout 输出 JSON {词: 词条全文}
import Foundation
import CoreServices

let args = CommandLine.arguments.dropFirst().joined(separator: " ")
let words = args.split(separator: ",").map(String.init).filter { !$0.isEmpty }
var out: [String: String] = [:]
for w in words {
  let ns = w as NSString
  if let r = DCSCopyTextDefinition(nil, ns, CFRange(location: 0, length: ns.length)),
     let def = r.takeUnretainedValue() as? String {
    out[w] = def
  }
}
let data = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
