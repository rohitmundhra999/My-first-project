function SELECTALL() {
  var spreadsheet = SpreadsheetApp.getActive();
  spreadsheet.getRange('A5:A54').activate();
  spreadsheet.getActiveRangeList().check();
};


function CLEARALL() {
  var spreadsheet = SpreadsheetApp.getActive();
  spreadsheet.getRange('A5:A54').activate();
  spreadsheet.getActiveRangeList().uncheck();
};
